use crate::analyze;
use crate::arggen::{build_fields, build_ytdlp_args, tag_override_args, TagOverride};
use crate::config::AppSettings;
use crate::error::{AppError, AppResult};
use crate::history::{HistoryDb, HistoryItem, PersistedJob};
use crate::logger;
use crate::process::{kill_tree, new_command};
use crate::progress::{self, ProgressUpdate};
use crate::tools::resolve_all;
use crate::util::{build_output_path, redact_url, unique_path};
use serde::{Deserialize, Serialize};
use tauri::Emitter;
use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub const STATUS_PENDING: &str = "pending";
pub const STATUS_FETCHING: &str = "fetching";
pub const STATUS_DOWNLOADING: &str = "downloading";
pub const STATUS_PROCESSING: &str = "processing";
pub const STATUS_COMPLETED: &str = "completed";
pub const STATUS_FAILED: &str = "failed";
pub const STATUS_CANCELLED: &str = "cancelled";
pub const STATUS_SKIPPED: &str = "skipped";
pub const STATUS_INTERRUPTED: &str = "interrupted";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub id: String,
    pub url: String,
    pub title: Option<String>,
    pub thumbnail: Option<String>,
    pub media_id: Option<String>,
    pub uploader: Option<String>,
    pub channel: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub track: Option<String>,
    pub playlist_title: Option<String>,
    pub upload_date: Option<String>,
    pub release_date: Option<String>,
    pub genre: Option<String>,
    pub track_number: Option<i64>,
    pub playlist_index: Option<i64>,
    pub format: String,
    pub quality: String,
    pub status: String,
    pub progress: f64,
    pub speed: Option<String>,
    pub eta: Option<String>,
    pub downloaded: Option<u64>,
    pub total: Option<u64>,
    pub stage: Option<String>,
    pub error: Option<String>,
    pub output_path: Option<String>,
    pub file_size: Option<i64>,
    pub duration: Option<f64>,
    pub created_at: i64,
    pub completed_at: Option<i64>,
    pub extractor: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadRequest {
    pub url: String,
    pub format: String,
    pub quality: String,
    pub title: Option<String>,
    pub thumbnail: Option<String>,
    pub media_id: Option<String>,
    pub uploader: Option<String>,
    pub channel: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub track: Option<String>,
    pub playlist_title: Option<String>,
    pub upload_date: Option<String>,
    pub release_date: Option<String>,
    pub genre: Option<String>,
    pub track_number: Option<i64>,
    pub playlist_index: Option<i64>,
    pub duration: Option<f64>,
    pub extractor: Option<String>,
    /// Skip duplicate detection: History's "Download again" is an explicit
    /// request and must never be answered with "Skipped".
    #[serde(default)]
    pub force: Option<bool>,
}

struct ManagerInner {
    jobs: HashMap<String, Job>,
    queue: VecDeque<String>,
    running: HashMap<String, u32>,
    cancelled: HashSet<String>,
    /// Jobs submitted with `force` (kept outside `Job`, which is also built
    /// by the integration tests).
    forced: HashSet<String>,
    /// Tags the request supplied explicitly, written instead of yt-dlp's own.
    tags: HashMap<String, TagOverride>,
}

/// Why a worker must stop before or between its stages.
enum Stop {
    Cancelled,
    Removed,
}

pub struct DownloadManager {
    inner: Mutex<ManagerInner>,
    history: HistoryDb,
    app: Mutex<Option<tauri::AppHandle>>,
    shutdown: AtomicBool,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

impl DownloadManager {
    pub fn new() -> Arc<Self> {
        let history = HistoryDb::open().unwrap_or_else(|_| HistoryDb::open_at_temp());
        Arc::new(Self {
            inner: Mutex::new(ManagerInner {
                jobs: HashMap::new(),
                queue: VecDeque::new(),
                running: HashMap::new(),
                cancelled: HashSet::new(),
                forced: HashSet::new(),
                tags: HashMap::new(),
            }),
            history,
            app: Mutex::new(None),
            shutdown: AtomicBool::new(false),
        })
    }

    pub fn set_app(self: &Arc<Self>, app: tauri::AppHandle) {
        *self.app.lock().unwrap() = Some(app);
    }

    /// Access to the SQLite history database.
    pub fn history_db(&self) -> &HistoryDb {
        &self.history
    }

    fn app_handle(&self) -> Option<tauri::AppHandle> {
        self.app.lock().unwrap().clone()
    }

    // ---------- public API ----------

    pub fn submit(self: &Arc<Self>, req: DownloadRequest) -> AppResult<Job> {
        let id = uuid::Uuid::new_v4().to_string();
        let now = now_ms();
        let force = req.force.unwrap_or(false);
        let tags = TagOverride::from_request(&req);
        let job = Job {
            id: id.clone(),
            url: req.url,
            title: req.title,
            thumbnail: req.thumbnail,
            media_id: req.media_id,
            uploader: req.uploader,
            channel: req.channel,
            artist: req.artist,
            album: req.album,
            track: req.track,
            playlist_title: req.playlist_title,
            upload_date: req.upload_date,
            release_date: req.release_date,
            genre: req.genre,
            track_number: req.track_number,
            playlist_index: req.playlist_index,
            format: if req.format.is_empty() { "mp3".to_string() } else { req.format },
            quality: if req.quality.is_empty() { "best".to_string() } else { req.quality },
            status: STATUS_PENDING.to_string(),
            progress: 0.0,
            speed: None,
            eta: None,
            downloaded: None,
            total: None,
            stage: Some("Queued".to_string()),
            error: None,
            output_path: None,
            file_size: None,
            duration: req.duration,
            created_at: now,
            completed_at: None,
            extractor: req.extractor,
        };

        {
            let mut inner = self.inner.lock().unwrap();
            inner.jobs.insert(id.clone(), job.clone());
            inner.queue.push_back(id.clone());
            if force {
                inner.forced.insert(id.clone());
            }
            if !tags.is_empty() {
                inner.tags.insert(id.clone(), tags);
            }
        }
        self.persist_job(&job);
        logger::job_info(&id, "submit", &format!("Queued {} ({})", redact_url(&job.url), job.format));
        self.pump();
        Ok(job)
    }

    pub fn cancel(self: &Arc<Self>, id: &str) -> AppResult<()> {
        let mut inner = self.inner.lock().unwrap();
        if let Some(pid) = inner.running.get(id).copied() {
            // Record the cancel first: the worker checks it when the process
            // dies, and before it spawns one (pid 0 = still fetching info).
            inner.cancelled.insert(id.to_string());
            if pid == 0 {
                if let Some(j) = inner.jobs.get_mut(id) {
                    j.stage = Some("Cancelling…".to_string());
                }
            }
            // taskkill can take a while; never run it under the manager lock.
            drop(inner);
            if pid != 0 {
                kill_tree(pid);
            } else {
                self.emit_job(id);
            }
            return Ok(());
        }
        let is_pending = inner
            .jobs
            .get(id)
            .map(|j| j.status == STATUS_PENDING)
            .unwrap_or(false);
        if is_pending {
            inner.queue.retain(|q| q != id);
            let now = now_ms();
            if let Some(job) = inner.jobs.get_mut(id) {
                job.status = STATUS_CANCELLED.to_string();
                job.completed_at = Some(now);
            }
            drop(inner);
            let job = self.inner.lock().unwrap().jobs.get(id).cloned();
            if let Some(j) = job {
                self.persist_job(&j);
                self.emit_job(id);
            }
            logger::job_info(id, "cancel", "Cancelled before start");
        }
        Ok(())
    }

    pub fn retry(self: &Arc<Self>, id: &str) -> AppResult<()> {
        {
            let mut inner = self.inner.lock().unwrap();
            let Some(job) = inner.jobs.get_mut(id) else {
                return Ok(());
            };
            job.status = STATUS_PENDING.to_string();
            job.progress = 0.0;
            job.speed = None;
            job.eta = None;
            job.downloaded = None;
            job.total = None;
            job.error = None;
            job.stage = Some("Queued".to_string());
            job.completed_at = None;
        }
        let job = {
            let mut inner = self.inner.lock().unwrap();
            inner.cancelled.remove(id);
            inner.queue.push_back(id.to_string());
            inner.jobs.get(id).cloned()
        };
        if let Some(j) = job {
            self.persist_job(&j);
        }
        logger::job_info(id, "retry", "Re-queued for retry");
        self.pump();
        Ok(())
    }

    pub fn remove_job(self: &Arc<Self>, id: &str) -> AppResult<()> {
        let pid = {
            let mut inner = self.inner.lock().unwrap();
            inner.queue.retain(|q| q != id);
            inner.cancelled.remove(id);
            inner.forced.remove(id);
            inner.tags.remove(id);
            inner.jobs.remove(id);
            // The worker owns its `running` entry and drops it once it sees
            // the job is gone.
            inner.running.get(id).copied().unwrap_or(0)
        };
        if pid != 0 {
            kill_tree(pid);
        }
        self.history.delete_job(id).ok();
        Ok(())
    }

    pub fn clear_completed(self: &Arc<Self>) -> AppResult<()> {
        let mut inner = self.inner.lock().unwrap();
        let terminal: Vec<String> = inner
            .jobs
            .iter()
            .filter(|(_, j)| {
                matches!(
                    j.status.as_str(),
                    STATUS_COMPLETED
                        | STATUS_FAILED
                        | STATUS_CANCELLED
                        | STATUS_SKIPPED
                        | STATUS_INTERRUPTED
                )
            })
            .map(|(id, _)| id.clone())
            .collect();
        for id in terminal {
            inner.jobs.remove(&id);
            inner.forced.remove(&id);
            inner.tags.remove(&id);
            self.history.delete_job(&id).ok();
        }
        Ok(())
    }

    pub fn list_jobs(&self) -> Vec<Job> {
        let inner = self.inner.lock().unwrap();
        let mut jobs: Vec<Job> = inner.jobs.values().cloned().collect();
        jobs.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        jobs
    }

    /// Bring back the previous session's queue, or forget it when the user
    /// chose to start with an empty queue (Settings → startup behaviour).
    pub fn restore_persisted_jobs(self: &Arc<Self>) {
        if !should_restore_queue(&AppSettings::load()) {
            self.history.clear_jobs().ok();
            return;
        }
        let jobs = self.history.load_jobs().unwrap_or_default();
        let mut inner = self.inner.lock().unwrap();
        for pj in jobs {
            if inner.jobs.contains_key(&pj.id) {
                continue;
            }
            let status = if matches!(
                pj.status.as_str(),
                STATUS_DOWNLOADING | STATUS_FETCHING | STATUS_PENDING | STATUS_PROCESSING
            ) {
                STATUS_INTERRUPTED.to_string()
            } else {
                pj.status.clone()
            };
            let job = Job {
                id: pj.id.clone(),
                url: pj.url,
                format: pj.format,
                quality: pj.quality,
                title: pj.title,
                thumbnail: pj.thumbnail,
                media_id: pj.media_id,
                uploader: None,
                channel: None,
                artist: None,
                album: None,
                track: None,
                playlist_title: None,
                upload_date: None,
                release_date: None,
                genre: None,
                track_number: None,
                playlist_index: None,
                status,
                progress: 0.0,
                speed: None,
                eta: None,
                downloaded: None,
                total: None,
                stage: Some("Interrupted — press Retry to resume".to_string()),
                error: None,
                output_path: None,
                file_size: None,
                duration: None,
                created_at: pj.created_at,
                completed_at: None,
                extractor: None,
            };
            inner.jobs.insert(pj.id, job);
        }
    }

    pub fn shutdown(self: &Arc<Self>) {
        self.shutdown.store(true, Ordering::SeqCst);
        let pids: Vec<u32> = self
            .inner
            .lock()
            .unwrap()
            .running
            .values()
            .copied()
            .filter(|p| *p != 0)
            .collect();
        for pid in pids {
            kill_tree(pid);
        }
    }

    // ---------- scheduling ----------

    fn pump(self: &Arc<Self>) {
        loop {
            let id = {
                let mut inner = self.inner.lock().unwrap();
                if self.shutdown.load(Ordering::SeqCst) {
                    return;
                }
                let settings = AppSettings::load();
                let max = settings.max_concurrent.max(1);
                if inner.running.len() >= max {
                    return;
                }
                let Some(id) = inner.queue.pop_front() else {
                    return;
                };
                if inner.jobs.get(&id).map(|j| j.status.as_str()) != Some(STATUS_PENDING) {
                    continue;
                }
                inner.running.insert(id.clone(), 0);
                id
            };
            self.spawn_worker(id);
        }
    }

    fn spawn_worker(self: &Arc<Self>, id: String) {
        let this = self.clone();
        std::thread::spawn(move || this.worker(&id));
    }

    // ---------- worker ----------

    fn worker(self: &Arc<Self>, id: &str) {
        let Some(app) = self.app_handle() else {
            return;
        };
        let (job, force, tags) = {
            let inner = self.inner.lock().unwrap();
            (
                inner.jobs.get(id).cloned(),
                inner.forced.contains(id),
                inner.tags.get(id).cloned().unwrap_or_default(),
            )
        };
        let Some(mut job) = job else {
            self.release_slot(id);
            return;
        };

        let settings = AppSettings::load();

        // 1. Fetch metadata if we don't have a title yet (raw URL queue items).
        if job.title.is_none() || job.media_id.is_none() {
            self.set_status(id, STATUS_FETCHING, Some("Fetching media information…"));
            self.emit_job(id);
            let fetched = analyze::fetch_media(&job.url);
            // Cancel or Remove pressed while fetching only marked the job:
            // there was no download process to kill yet.
            if let Some(stop) = self.stop_requested(id) {
                self.stop(id, stop, &app);
                return;
            }
            match fetched {
                Ok(f) => {
                    job.title = f.media.title.clone();
                    job.thumbnail = f.media.thumbnail.clone();
                    job.media_id = f.media.id.clone();
                    job.uploader = f.media.uploader.clone();
                    job.channel = f.media.channel.clone();
                    job.duration = f.media.duration;
                    job.extractor = f.media.extractor.clone();
                    job.album = f.media.album.clone();
                    job.artist = f.media.artist.clone();
                    job.track = f.media.track.clone();
                    job.upload_date = f.media.upload_date.clone();
                    job.release_date = f.media.release_date.clone();
                    job.genre = f.media.genre.clone();
                    job.track_number = f.media.track_number;
                    job.url = f.url;
                    // Update in place only: re-inserting would bring back a
                    // job that was removed meanwhile.
                    let mut inner = self.inner.lock().unwrap();
                    match inner.jobs.get_mut(id) {
                        Some(slot) => *slot = job.clone(),
                        None => {
                            drop(inner);
                            self.stop(id, Stop::Removed, &app);
                            return;
                        }
                    }
                }
                Err(e) => {
                    self.fail(id, &e, None, &app);
                    return;
                }
            }
        }

        // 2. Duplicate detection: same media, same format, file still on disk.
        let mut force_overwrite = false;
        let mut force_new_copy = false;
        if !force {
            if let Some(mid) = &job.media_id {
                if let Some(existing) = self.history.find_completed_duplicate(mid, &job.format) {
                    match settings.duplicate_handling.as_str() {
                        "replace" => force_overwrite = true,
                        "new_copy" => force_new_copy = true,
                        _ => {
                            logger::job_info(id, "duplicate", "Already downloaded — skipping per settings");
                            self.finish_skipped(id, existing.file_path, &app);
                            return;
                        }
                    }
                }
            }
        }

        // 3. Resolve tools.
        let tools = match resolve_all(&settings) {
            Ok(t) => t,
            Err(e) => {
                self.fail(id, &e, None, &app);
                return;
            }
        };

        // 4. Compute a safe output path.
        let ext = if job.format == "mp4" { "mp4" } else { "mp3" };
        let fields = build_fields(&job, ext);
        let planned = match build_output_path(
            &settings.output_dir,
            &settings.filename_template,
            &fields,
            ext,
        ) {
            Ok(p) => p,
            Err(e) => {
                self.fail(id, &e, None, &app);
                return;
            }
        };
        // A file already at that name that history records for a DIFFERENT
        // song (long titles are sliced and can collide) is not this download:
        // never skip or overwrite it, write a numbered copy instead.
        let other_song = planned.exists()
            && job.media_id.is_some()
            && self
                .history
                .media_id_for_file(&planned.to_string_lossy())
                .is_some_and(|m| Some(m) != job.media_id);
        // A forced download ("Download again") never ends as "Skipped": if
        // the file is still there it gets a new copy unless set to replace.
        let chosen = if other_song {
            Some(unique_path(&planned))
        } else {
            choose_output_path(&planned, &settings.overwrite_behavior, force_overwrite, force_new_copy || force)
        };
        let Some(out_path) = chosen else {
            logger::job_info(id, "existing_file", "Output file already exists — skipping per settings");
            self.finish_skipped(id, planned.to_string_lossy().to_string(), &app);
            return;
        };

        // 5. Build arguments (structured array, no shell).
        let mut args = build_ytdlp_args(&job, &settings, &tools, &out_path, force_overwrite);
        if settings.embed_metadata {
            args.extend(tag_override_args(&tags));
        }
        logger::job_info(
            id,
            "spawn",
            &format!(
                "yt-dlp {} -o {}",
                args.iter().map(|a| redact_url(a)).collect::<Vec<_>>().join(" "),
                out_path.display()
            ),
        );

        // 6. Spawn the process, unless a cancel or removal arrived meanwhile.
        if let Some(stop) = self.stop_requested(id) {
            self.stop(id, stop, &app);
            return;
        }
        let mut cmd = new_command(&tools.ytdlp);
        cmd.args(&args);
        cmd.stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .stdin(Stdio::null());
        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                self.fail(id, &AppError::io("Starting yt-dlp", e), None, &app);
                return;
            }
        };
        // Publish the pid and re-check under one lock: a cancel that landed
        // between the check above and here saw pid 0 and killed nothing.
        let late_stop = {
            let mut inner = self.inner.lock().unwrap();
            let stop = if !inner.jobs.contains_key(id) {
                Some(Stop::Removed)
            } else if inner.cancelled.contains(id) {
                Some(Stop::Cancelled)
            } else {
                None
            };
            if stop.is_none() {
                inner.running.insert(id.to_string(), child.id());
            }
            stop
        };
        if let Some(stop) = late_stop {
            kill_tree(child.id());
            let _ = child.kill();
            let _ = child.wait();
            self.stop(id, stop, &app);
            return;
        }
        self.set_status(id, STATUS_DOWNLOADING, Some("Starting download…"));
        self.emit_job(id);

        // 7. Stream output. With --no-quiet, progress and stage lines arrive
        // on stdout together with the `--print after_move:filepath` line;
        // stderr carries only errors and warnings.
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();

        let stderr_reader = stderr.map(|err| {
            std::thread::spawn(move || {
                let mut text = String::new();
                for line in lossy_lines(BufReader::new(err)) {
                    text.push_str(&line);
                    text.push('\n');
                    if text.len() > 200_000 {
                        text = text.split_off(text.len() - 100_000);
                    }
                }
                text
            })
        });

        let mut update = ProgressUpdate::default();
        let mut last_emit = Instant::now();
        let mut printed_path: Option<String> = None;
        let mut last_destination: Option<String> = None;

        if let Some(out) = stdout {
            for line in lossy_lines(BufReader::new(out)) {
                let trimmed = line.trim();
                if looks_like_file_path(trimmed) {
                    printed_path = Some(trimmed.to_string());
                }
                update.output_path = None;
                progress::parse_line(trimmed, &mut update);
                if let Some(p) = update.output_path.clone() {
                    last_destination = Some(p.clone());
                    self.record_output_path(id, &p);
                }

                {
                    let mut inner = self.inner.lock().unwrap();
                    let Some(j) = inner.jobs.get_mut(id) else {
                        continue;
                    };
                    j.progress = update.percent.unwrap_or(j.progress);
                    j.speed = update.speed.clone();
                    j.eta = update.eta.clone();
                    j.downloaded = update.downloaded_bytes;
                    j.total = update.total_bytes;
                    if let Some(s) = &update.stage {
                        j.stage = Some(s.clone());
                        if s == "Processing" && j.status == STATUS_DOWNLOADING {
                            j.status = STATUS_PROCESSING.to_string();
                        }
                    }
                    if update.skipped {
                        j.status = STATUS_SKIPPED.to_string();
                    }
                }

                if last_emit.elapsed() >= Duration::from_millis(120) {
                    self.emit_job(id);
                    last_emit = Instant::now();
                }
            }
        }

        let status = child.wait();
        let stderr_text = stderr_reader
            .and_then(|h| h.join().ok())
            .unwrap_or_default();
        let (is_cancelled, removed) = {
            let mut inner = self.inner.lock().unwrap();
            inner.running.remove(id);
            (inner.cancelled.contains(id), !inner.jobs.contains_key(id))
        };

        // 8. Finalize. The `--print after_move:filepath` line is the final
        // file; a Destination line may name an intermediate (.webm, .f137.mp4).
        let reported = printed_path.or(last_destination);
        if removed {
            self.stop(id, Stop::Removed, &app);
            return;
        }
        if update.skipped {
            let p = reported
                .clone()
                .unwrap_or_else(|| out_path.to_string_lossy().to_string());
            self.finish_skipped(id, p, &app);
            return;
        }
        if is_cancelled {
            self.finish_cancelled(id, &app);
            return;
        }
        if !status.map(|s| s.success()).unwrap_or(false) {
            let msg = friendly_ytdlp_error(&stderr_text);
            self.fail(id, &msg, Some(&stderr_text), &app);
            return;
        }

        let final_path = choose_final_path(reported.as_deref(), &out_path);
        let file_size = std::fs::metadata(&final_path).ok().map(|m| m.len() as i64);
        self.finish_completed(id, &final_path, file_size, &app);
    }

    /// A cancel or removal requested while the worker was busy elsewhere.
    fn stop_requested(&self, id: &str) -> Option<Stop> {
        let inner = self.inner.lock().unwrap();
        if !inner.jobs.contains_key(id) {
            Some(Stop::Removed)
        } else if inner.cancelled.contains(id) {
            Some(Stop::Cancelled)
        } else {
            None
        }
    }

    fn stop(self: &Arc<Self>, id: &str, stop: Stop, app: &tauri::AppHandle) {
        match stop {
            Stop::Cancelled => {
                logger::job_info(id, "cancel", "Cancelled");
                self.finish_cancelled(id, app);
            }
            Stop::Removed => self.release_slot(id),
        }
    }

    /// Give up the concurrency slot of a job that no longer exists.
    fn release_slot(self: &Arc<Self>, id: &str) {
        {
            let mut inner = self.inner.lock().unwrap();
            inner.running.remove(id);
            inner.cancelled.remove(id);
        }
        self.pump();
    }

    // ---------- helpers ----------

    fn record_output_path(&self, id: &str, path: &str) {
        let mut inner = self.inner.lock().unwrap();
        if let Some(j) = inner.jobs.get_mut(id) {
            j.output_path = Some(path.to_string());
        }
    }

    fn set_status(&self, id: &str, status: &str, stage: Option<&str>) {
        let mut inner = self.inner.lock().unwrap();
        if let Some(j) = inner.jobs.get_mut(id) {
            j.status = status.to_string();
            if let Some(s) = stage {
                j.stage = Some(s.to_string());
            }
        }
    }

    fn persist_job(&self, job: &Job) {
        let pj = PersistedJob {
            id: job.id.clone(),
            url: job.url.clone(),
            format: job.format.clone(),
            quality: job.quality.clone(),
            title: job.title.clone(),
            thumbnail: job.thumbnail.clone(),
            media_id: job.media_id.clone(),
            created_at: job.created_at,
            status: job.status.clone(),
        };
        self.history.save_job(&pj).ok();
    }

    fn emit_job(&self, id: &str) {
        let job = self.inner.lock().unwrap().jobs.get(id).cloned();
        if let Some(app) = self.app_handle() {
            if let Some(job) = job {
                let _ = app.emit("download-updated", &job);
            }
        }
    }

    fn finish_completed(
        self: &Arc<Self>,
        id: &str,
        path: &str,
        file_size: Option<i64>,
        app: &tauri::AppHandle,
    ) {
        let now = now_ms();
        let job = {
            let mut inner = self.inner.lock().unwrap();
            inner.cancelled.remove(id);
            let Some(j) = inner.jobs.get_mut(id) else {
                drop(inner);
                self.pump();
                return;
            };
            j.status = STATUS_COMPLETED.to_string();
            j.progress = 100.0;
            j.output_path = Some(path.to_string());
            j.file_size = file_size;
            j.completed_at = Some(now);
            j.stage = Some("Completed".to_string());
            j.clone()
        };

        let item = HistoryItem {
            id: job.id.clone(),
            title: job.title.clone(),
            url: job.url.clone(),
            media_id: job.media_id.clone(),
            extractor: job.extractor.clone(),
            thumbnail: job.thumbnail.clone(),
            format: job.format.clone(),
            quality: job.quality.clone(),
            file_path: path.to_string(),
            file_size,
            duration: job.duration,
            status: STATUS_COMPLETED.to_string(),
            created_at: now,
        };
        self.history.insert_history(&item).ok();
        self.persist_job(&job);

        logger::job_info(id, "completed", &format!("Saved to {}", path));
        let _ = app.emit("download-finished", &job);
        self.emit_job(id);
        if AppSettings::load().notify_on_complete {
            notify_completed(app, job.title.as_deref().unwrap_or("Download"), path);
        }
        self.pump();
    }

    fn finish_skipped(self: &Arc<Self>, id: &str, path: String, app: &tauri::AppHandle) {
        let now = now_ms();
        let job = {
            let mut inner = self.inner.lock().unwrap();
            inner.running.remove(id);
            inner.cancelled.remove(id);
            let Some(j) = inner.jobs.get_mut(id) else {
                drop(inner);
                self.pump();
                return;
            };
            j.status = STATUS_SKIPPED.to_string();
            j.output_path = Some(path.clone());
            j.completed_at = Some(now);
            j.stage = Some("Skipped — file already exists".to_string());
            j.clone()
        };
        let item = HistoryItem {
            id: job.id.clone(),
            title: job.title.clone(),
            url: job.url.clone(),
            media_id: job.media_id.clone(),
            extractor: job.extractor.clone(),
            thumbnail: job.thumbnail.clone(),
            format: job.format.clone(),
            quality: job.quality.clone(),
            file_path: path,
            file_size: None,
            duration: job.duration,
            status: STATUS_SKIPPED.to_string(),
            created_at: now,
        };
        self.history.insert_history(&item).ok();
        self.persist_job(&job);
        let _ = app.emit("download-finished", &job);
        self.emit_job(id);
        self.pump();
    }

    fn finish_cancelled(self: &Arc<Self>, id: &str, app: &tauri::AppHandle) {
        let now = now_ms();
        {
            let mut inner = self.inner.lock().unwrap();
            if let Some(j) = inner.jobs.get_mut(id) {
                j.status = STATUS_CANCELLED.to_string();
                j.completed_at = Some(now);
                j.stage = Some("Cancelled".to_string());
            }
            inner.cancelled.remove(id);
            // Set when cancelled before yt-dlp started (pid 0 placeholder).
            inner.running.remove(id);
        }
        let job = self.inner.lock().unwrap().jobs.get(id).cloned();
        if let Some(job) = job {
            self.persist_job(&job);
            let _ = app.emit("download-finished", &job);
            self.emit_job(id);
        }
        self.pump();
    }

    fn fail(
        self: &Arc<Self>,
        id: &str,
        error: &AppError,
        detail: Option<&str>,
        app: &tauri::AppHandle,
    ) {
        let now = now_ms();
        let detail = detail.unwrap_or_else(|| error.detail.as_deref().unwrap_or(""));
        {
            let mut inner = self.inner.lock().unwrap();
            if let Some(j) = inner.jobs.get_mut(id) {
                j.status = STATUS_FAILED.to_string();
                j.error = Some(error.message.clone());
                j.completed_at = Some(now);
                j.stage = Some("Failed".to_string());
            }
            inner.running.remove(id);
            inner.cancelled.remove(id);
        }
        let job = self.inner.lock().unwrap().jobs.get(id).cloned();
        if let Some(job) = job {
            self.persist_job(&job);
            logger::job_error(id, "failed", &error.message, Some(detail), None);
            let _ = app.emit(
                "download-failed",
                &serde_json::json!({
                    "job": job,
                    "error": error,
                    "detail": detail,
                }),
            );
            self.emit_job(id);
        }
        self.pump();
    }
}

/// Lines of a child's output, decoded leniently. `BufRead::lines` yields an
/// error for any line that is not valid UTF-8, and the callers used to skip
/// such lines, which lost the final file path for titles with emoji.
fn lossy_lines<R: BufRead>(reader: R) -> impl Iterator<Item = String> {
    reader.split(b'\n').map_while(Result::ok).map(|bytes| {
        let line = String::from_utf8_lossy(&bytes).into_owned();
        line.trim_end_matches('\r').to_string()
    })
}

/// The path to record for a finished download. yt-dlp's own report wins when
/// that file exists; otherwise fall back to the exact path we passed as `-o`.
/// Recording a path that does not exist breaks Open, Show in folder and
/// Open in Audio Studio for that history entry.
fn choose_final_path(reported: Option<&str>, requested: &Path) -> String {
    match reported {
        Some(p) if Path::new(p).exists() => p.to_string(),
        Some(p) if !requested.exists() => p.to_string(),
        _ => requested.to_string_lossy().to_string(),
    }
}

/// Where to write, given the planned path and the settings. `None` means the
/// file is already there and the job should end as skipped.
fn choose_output_path(
    planned: &Path,
    overwrite_behavior: &str,
    force_overwrite: bool,
    force_new_copy: bool,
) -> Option<PathBuf> {
    if force_overwrite || overwrite_behavior == "replace" {
        return Some(planned.to_path_buf());
    }
    if force_new_copy || overwrite_behavior == "new_copy" {
        return Some(unique_path(planned));
    }
    if planned.exists() {
        return None;
    }
    Some(planned.to_path_buf())
}

/// Settings → startup behaviour: "restore" (default) brings the last queue
/// back; anything else ("empty") starts with an empty queue.
fn should_restore_queue(settings: &AppSettings) -> bool {
    settings.startup_behavior != "empty"
}

/// Windows toast for a finished download (Settings → notify on complete).
fn notify_completed(app: &tauri::AppHandle, title: &str, path: &str) {
    let name = Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| title.to_string());
    let body = format!("{title}\nSaved as {name}");
    // A packaged (MSIX) app must send toasts under its own AppUserModelID;
    // the plugin always uses the bundle identifier, which Windows rejects
    // for a packaged process, so the toast would silently never appear.
    #[cfg(windows)]
    if let Some(aumid) = crate::config::package_app_user_model_id() {
        let result = tauri_winrt_notification::Toast::new(&aumid)
            .title("Download complete")
            .text1(title)
            .text2(&format!("Saved as {name}"))
            .show();
        if let Err(e) = result {
            logger::info("notify", &format!("Could not show a notification: {e}"));
        }
        return;
    }
    use tauri_plugin_notification::NotificationExt;
    if let Err(e) = app
        .notification()
        .builder()
        .title("Download complete")
        .body(body)
        .show()
    {
        logger::info("notify", &format!("Could not show a notification: {e}"));
    }
}

/// A bare path line from `--print after_move:filepath`. Bracketed lines
/// (`[download] Destination: …`) also end in a media extension and are
/// progress output, not the final path.
fn looks_like_file_path(line: &str) -> bool {
    if line.starts_with('[') {
        return false;
    }
    let lower = line.to_lowercase();
    line.starts_with("\\\\")
        || (line.len() >= 3
        && line.as_bytes().get(1) == Some(&b':')
        && line.as_bytes().get(2) == Some(&b'\\'))
        || lower.ends_with(".mp3")
        || lower.ends_with(".mp4")
        || lower.ends_with(".m4a")
        || lower.ends_with(".webm")
        || lower.ends_with(".mkv")
        || lower.ends_with(".part")
}

/// Translate raw yt-dlp stderr into a friendly, actionable error message.
pub fn friendly_ytdlp_error(stderr: &str) -> AppError {
    let lower = stderr.to_lowercase();
    let detail = truncate(stderr, 3000);
    let message = if lower.contains("unsupported url") {
        "This URL is not supported by yt-dlp.".to_string()
    } else if lower.contains("video unavailable") {
        "The video is unavailable — it may be private, removed, or restricted in your region.".to_string()
    } else if lower.contains("sign in to confirm") || lower.contains("confirm you're not a bot") {
        "The service is asking to verify you are not a bot. If you are authorized to access this content, provide a cookies file in Settings → yt-dlp.".to_string()
    } else if lower.contains("ffmpeg") && (lower.contains("not found") || lower.contains("not installed")) {
        "FFmpeg is missing. Install it from the Diagnostics screen.".to_string()
    } else if lower.contains("requested format is not available") || lower.contains("has no formats") {
        "No matching media formats are available for this item.".to_string()
    } else if lower.contains("private video") {
        "This is a private video. Sign in and provide a cookies file if you are authorized.".to_string()
    } else if lower.contains("login required") || lower.contains("authentication required") {
        "This content requires authentication. Provide a cookies file in Settings if you are authorized.".to_string()
    } else if lower.contains("age-restricted") || lower.contains("age restricted") {
        "This content is age-restricted.".to_string()
    } else if lower.contains("no entries") {
        "This playlist is empty or its entries could not be fetched.".to_string()
    } else if lower.contains("timed out") || lower.contains("timeout") {
        "The request timed out — check your network connection and try again.".to_string()
    } else if lower.contains("getaddrinfo")
        || lower.contains("name or service not known")
        || lower.contains("couldn't connect")
        || lower.contains("connection refused")
    {
        "Network error while contacting the media service.".to_string()
    } else if lower.contains("http error 403") {
        "The service rejected the request (HTTP 403). This usually means yt-dlp is out of date and YouTube is blocking its current extraction method — open Diagnostics and check for a yt-dlp update first. It can also require cookies or be region-blocked.".to_string()
    } else {
        format!(
            "yt-dlp failed to process this media (exit {})",
            detail.lines().next().unwrap_or("unknown error")
        )
    };
    AppError::with_detail("download_failed", message, detail)
}

fn truncate(s: &str, max: usize) -> String {
    let t = s.trim();
    if t.chars().count() > max {
        let mut out: String = t.chars().take(max).collect();
        out.push_str("\n… (truncated)");
        out
    } else {
        t.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn friendly_error_maps_unsupported_url() {
        let e = friendly_ytdlp_error("ERROR: Unsupported URL: https://foo.bar");
        assert!(e.message.contains("not supported"));
        assert_eq!(e.code, "download_failed");
    }

    #[test]
    fn friendly_error_maps_bot_check() {
        let e = friendly_ytdlp_error("Sign in to confirm you're not a bot");
        assert!(e.message.contains("bot"));
    }

    #[test]
    fn friendly_error_maps_ffmpeg_missing() {
        let e = friendly_ytdlp_error("ffmpeg not found. Please install or provide the path");
        assert!(e.message.contains("FFmpeg is missing"));
    }

    #[test]
    fn friendly_error_maps_403_to_ytdlp_update_hint() {
        let e = friendly_ytdlp_error("ERROR: unable to download video data: HTTP Error 403: Forbidden");
        assert!(e.message.contains("yt-dlp is out of date"));
        assert!(e.message.contains("Diagnostics"));
    }

    #[test]
    fn friendly_error_falls_back_with_exit() {
        let e = friendly_ytdlp_error("ERROR: something weird happened");
        assert!(e.message.contains("failed"));
        assert!(e.detail.is_some());
    }

    #[test]
    fn looks_like_path_win() {
        assert!(looks_like_file_path("C:\\Music\\song.mp3"));
        assert!(looks_like_file_path("\\\\nas\\music\\song.mp3"));
        assert!(!looks_like_file_path("[download] 42% of 5MiB"));
        assert!(!looks_like_file_path("ERROR: Unsupported URL"));
        // --no-quiet stdout lines that mention files but are not the result.
        assert!(!looks_like_file_path("[download] Destination: C:\\Music\\song.webm"));
        assert!(!looks_like_file_path("[ExtractAudio] Destination: C:\\Music\\song.mp3"));
        assert!(!looks_like_file_path("Deleting original file C:\\Music\\song.webm (pass -k to keep)"));
    }

    #[test]
    fn output_path_follows_settings_and_force() {
        let dir = std::env::temp_dir().join(format!("amen-outpath-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let free = dir.join("new.mp3");
        let taken = dir.join("taken.mp3");
        std::fs::write(&taken, b"x").unwrap();

        // Nothing there yet: always the planned path.
        assert_eq!(choose_output_path(&free, "skip", false, false), Some(free.clone()));
        // Existing file + "skip": skipped...
        assert_eq!(choose_output_path(&taken, "skip", false, false), None);
        // ...unless the request was forced / duplicate handling said new copy.
        let copy = choose_output_path(&taken, "skip", false, true).unwrap();
        assert_ne!(copy, taken);
        assert!(copy.to_string_lossy().contains("taken (1).mp3"));
        assert_eq!(choose_output_path(&taken, "new_copy", false, false), Some(copy));
        // Replace (setting or duplicate handling) writes over it.
        assert_eq!(choose_output_path(&taken, "replace", false, false), Some(taken.clone()));
        assert_eq!(choose_output_path(&taken, "skip", true, false), Some(taken.clone()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn startup_behavior_gates_queue_restore() {
        let mut s = AppSettings::default();
        assert!(should_restore_queue(&s));
        s.startup_behavior = "empty".to_string();
        assert!(!should_restore_queue(&s));
    }

    #[test]
    fn download_request_force_is_optional_camel_case() {
        let base = serde_json::json!({ "url": "https://x/v", "format": "mp3", "quality": "best" });
        let req: DownloadRequest = serde_json::from_value(base.clone()).unwrap();
        assert_eq!(req.force, None);
        let mut forced = base;
        forced["force"] = serde_json::json!(true);
        let req: DownloadRequest = serde_json::from_value(forced).unwrap();
        assert_eq!(req.force, Some(true));
    }
}
