use crate::config::AppSettings;
use crate::error::{AppError, AppResult};
use crate::process::{new_command, run_capture};
use crate::tools::{resolve_all, resolve_ytdlp};
use crate::util::redact_url;
use serde::Serialize;
use serde_json::Value;
use std::path::Path;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FormatInfo {
    pub format_id: Option<String>,
    pub ext: Option<String>,
    pub vcodec: Option<String>,
    pub acodec: Option<String>,
    pub abr: Option<f64>,
    pub tbr: Option<f64>,
    pub filesize: Option<i64>,
    pub format_note: Option<String>,
    pub height: Option<i64>,
    pub width: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaInfo {
    pub id: Option<String>,
    pub title: Option<String>,
    pub uploader: Option<String>,
    pub channel: Option<String>,
    pub duration: Option<f64>,
    pub view_count: Option<u64>,
    pub upload_date: Option<String>,
    pub thumbnail: Option<String>,
    pub webpage_url: Option<String>,
    pub original_url: Option<String>,
    pub extractor: Option<String>,
    pub extractor_key: Option<String>,
    pub description: Option<String>,
    pub album: Option<String>,
    pub artist: Option<String>,
    pub track: Option<String>,
    pub release_date: Option<String>,
    pub genre: Option<String>,
    pub track_number: Option<i64>,
    pub availability: Option<String>,
    pub age_limit: Option<i64>,
    pub playlist_index: Option<i64>,
    pub best_audio_bitrate: Option<f64>,
    pub best_audio_format: Option<String>,
    pub formats: Vec<FormatInfo>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistInfo {
    pub id: Option<String>,
    pub title: Option<String>,
    pub uploader: Option<String>,
    pub webpage_url: Option<String>,
    pub extractor: Option<String>,
    pub extractor_key: Option<String>,
    pub count: Option<i64>,
    pub entries: Vec<MediaInfo>,
}

#[derive(Debug, Clone, Serialize)]
pub enum AnalyzeResult {
    Media(MediaInfo),
    Playlist(PlaylistInfo),
    Unsupported,
}

fn opt_str(v: &Value, keys: &[&str]) -> Option<String> {
    for k in keys {
        if let Some(s) = v.get(k).and_then(|x| x.as_str()) {
            if !s.is_empty() {
                return Some(s.to_string());
            }
        }
    }
    None
}

fn opt_f64(v: &Value, keys: &[&str]) -> Option<f64> {
    for k in keys {
        if let Some(n) = v.get(k).and_then(|x| x.as_f64()) {
            return Some(n);
        }
    }
    None
}

fn opt_u64(v: &Value, keys: &[&str]) -> Option<u64> {
    for k in keys {
        if let Some(n) = v.get(k).and_then(|x| x.as_u64()) {
            return Some(n);
        }
    }
    None
}

fn opt_i64(v: &Value, keys: &[&str]) -> Option<i64> {
    for k in keys {
        if let Some(n) = v.get(k).and_then(|x| x.as_i64()) {
            return Some(n);
        }
    }
    None
}

fn format_upload_date(s: &str) -> Option<String> {
    if s.len() == 8 && s.chars().all(|c| c.is_ascii_digit()) {
        Some(format!("{}-{}-{}", &s[0..4], &s[4..6], &s[6..8]))
    } else {
        Some(s.to_string())
    }
}

fn thumbnail_of(v: &Value) -> Option<String> {
    if let Some(t) = v.get("thumbnail").and_then(|x| x.as_str()) {
        return Some(t.to_string());
    }
    v.get("thumbnails")
        .and_then(|arr| arr.as_array())
        .and_then(|arr| {
            arr.iter()
                .filter_map(|t| t.get("url").and_then(|u| u.as_str()).map(|s| s.to_string()))
                .last()
        })
}

fn parse_media(v: &Value) -> MediaInfo {
    let id = opt_str(v, &["id"]);
    let title = opt_str(v, &["title"]);
    let uploader = opt_str(v, &["uploader", "channel", "artist", "creator"]);
    let channel = opt_str(v, &["channel", "uploader", "creator"]);
    let duration = opt_f64(v, &["duration"]);
    let view_count = opt_u64(v, &["view_count"]);
    let upload_date = opt_str(v, &["upload_date"]).and_then(|s| format_upload_date(&s));
    let thumbnail = thumbnail_of(v);
    let webpage_url = opt_str(v, &["webpage_url"]);
    let original_url = opt_str(v, &["original_url"]);
    let extractor = opt_str(v, &["extractor"]);
    let extractor_key = opt_str(v, &["extractor_key"]);
    let description = opt_str(v, &["description"]).map(|s| {
        if s.chars().count() > 800 {
            s.chars().take(800).collect()
        } else {
            s
        }
    });
    let album = opt_str(v, &["album"]);
    let artist = opt_str(v, &["artist", "uploader", "channel", "creator"]);
    let track = opt_str(v, &["track", "title"]);
    let release_date = opt_str(v, &["release_date", "release_year"])
        .and_then(|s| format_upload_date(&s));
    let genre = opt_str(v, &["genre"]);
    let track_number = opt_i64(v, &["track_number", "playlist_index"]);
    let availability = opt_str(v, &["availability"]);
    let age_limit = opt_i64(v, &["age_limit"]);
    let playlist_index = opt_i64(v, &["playlist_index"]);

    let mut formats: Vec<FormatInfo> = Vec::new();
    let mut best_audio_bitrate: Option<f64> = None;
    let mut best_audio_format: Option<String> = None;
    if let Some(arr) = v.get("formats").and_then(|x| x.as_array()) {
        for f in arr {
            let acodec = opt_str(f, &["acodec"]);
            let abr = opt_f64(f, &["abr"]);
            if let Some(a) = acodec.as_deref() {
                if a != "none" && !a.is_empty() {
                    if let Some(b) = abr {
                        if best_audio_bitrate.map_or(true, |cur| b > cur) {
                            best_audio_bitrate = Some(b);
                            best_audio_format = Some(
                                opt_str(f, &["format_note", "ext"]).unwrap_or_else(|| "audio".to_string()),
                            );
                        }
                    }
                }
            }
            formats.push(FormatInfo {
                format_id: opt_str(f, &["format_id"]),
                ext: opt_str(f, &["ext"]),
                vcodec: opt_str(f, &["vcodec"]),
                acodec,
                abr,
                tbr: opt_f64(f, &["tbr"]),
                filesize: opt_i64(f, &["filesize", "filesize_approx"]),
                format_note: opt_str(f, &["format_note"]),
                height: opt_i64(f, &["height"]),
                width: opt_i64(f, &["width"]),
            });
        }
    }

    MediaInfo {
        id,
        title,
        uploader,
        channel,
        duration,
        view_count,
        upload_date,
        thumbnail,
        webpage_url,
        original_url,
        extractor,
        extractor_key,
        description,
        album,
        artist,
        track,
        release_date,
        genre,
        track_number,
        availability,
        age_limit,
        playlist_index,
        best_audio_bitrate,
        best_audio_format,
        formats,
    }
}

fn parse_entry(v: &Value) -> MediaInfo {
    // flat playlist entries only carry a subset of fields
    MediaInfo {
        id: opt_str(v, &["id"]),
        title: opt_str(v, &["title"]),
        uploader: opt_str(v, &["uploader", "channel", "artist", "creator"]),
        channel: opt_str(v, &["channel", "uploader"]),
        duration: opt_f64(v, &["duration"]),
        view_count: opt_u64(v, &["view_count"]),
        upload_date: opt_str(v, &["upload_date"]).and_then(|s| format_upload_date(&s)),
        thumbnail: thumbnail_of(v),
        webpage_url: opt_str(v, &["webpage_url", "url"]),
        original_url: opt_str(v, &["original_url", "url"]),
        extractor: opt_str(v, &["extractor"]),
        extractor_key: opt_str(v, &["extractor_key"]),
        description: None,
        album: None,
        artist: None,
        track: None,
        release_date: None,
        genre: None,
        track_number: None,
        availability: None,
        age_limit: None,
        playlist_index: opt_i64(v, &["playlist_index"]),
        best_audio_bitrate: None,
        best_audio_format: None,
        formats: Vec::new(),
    }
}

fn parse_result(v: &Value) -> AnalyzeResult {
    // A playlist-like result has an "entries" array.
    if let Some(entries) = v.get("entries").and_then(|x| x.as_array()) {
        let mut parsed = Vec::new();
        let mut seen = std::collections::HashSet::new();
        
        // Detect if this is a search result
        let extractor = opt_str(v, &["extractor"]).unwrap_or_default();
        let is_search = extractor.contains("search") || extractor.starts_with("ytsearch");
        
        // For search results, strictly limit to 5 entries
        let max_entries = if is_search { 5 } else { entries.len() };
        
        for e in entries.iter().take(max_entries) {
            let p = parse_entry(e);
            if let Some(id) = &p.id {
                if !seen.insert(id.clone()) {
                    continue;
                }
            }
            parsed.push(p);
            
            // Hard stop at 5 for search results
            if is_search && parsed.len() >= 5 {
                break;
            }
        }
        
        // Some extractors return a single "url" wrapper with one entry that is
        // effectively the media itself (e.g. some non-YouTube extractors).
        let top_title = opt_str(v, &["title"]);
        if parsed.len() == 1 && top_title.is_none() {
            let entry_url = parsed[0].webpage_url.clone();
            if entry_url.is_some() && v.get("id").is_none() {
                return AnalyzeResult::Media(parsed[0].clone());
            }
        }
        
        let count = Some(parsed.len() as i64);
        return AnalyzeResult::Playlist(PlaylistInfo {
            id: opt_str(v, &["id", "playlist_id"]),
            title: opt_str(v, &["playlist_title", "title"]),
            uploader: opt_str(v, &["playlist_uploader", "uploader", "channel"]),
            webpage_url: opt_str(v, &["webpage_url"]),
            extractor: opt_str(v, &["extractor"]),
            extractor_key: opt_str(v, &["extractor_key"]),
            count,
            entries: parsed,
        });
    }

    let _type = opt_str(v, &["_type"]).unwrap_or_else(|| "video".to_string());
    if _type == "playlist" || _type == "multi_video" {
        return AnalyzeResult::Unsupported;
    }

    AnalyzeResult::Media(parse_media(v))
}

/// Analyze a URL. `flat` requests playlist entries be fetched in flat mode
/// (fast, no per-entry extraction) — used for playlist previews.
pub fn analyze_url(url: &str, flat: bool) -> AppResult<AnalyzeResult> {
    let settings = AppSettings::load();
    let ytdlp = resolve_ytdlp(&settings).ok_or_else(|| {
        AppError::dependency("yt-dlp is not installed. Open Diagnostics to install it.")
    })?;

    let _ = flat; // flat-playlist is always requested; `flat` is kept for API clarity
    
    let is_url = url.starts_with("http://") || url.starts_with("https://");
    let target = if is_url {
        // For exact URLs, use --no-playlist to get single media
        url.to_string()
    } else {
        // For search queries, limit to 5 results maximum
        format!("ytsearch5:{}", url)
    };

    let mut args = vec![
        "--dump-single-json".to_string(),
        "--no-warnings".to_string(),
        "--quiet".to_string(),
    ];
    
    if is_url {
        // For exact URLs: disable playlist extraction, get single video
        args.push("--no-playlist".to_string());
    } else {
        // For searches: use flat-playlist to avoid downloading full metadata
        args.push("--flat-playlist".to_string());
    }
    
    // After "--" the target can only be read as a URL or search, never as an
    // option (see arggen.rs).
    args.push("--".to_string());
    args.push(target);

    let mut cmd = new_command(&ytdlp);
    cmd.args(&args);
    let start = std::time::Instant::now();
    let Some(raw) = run_capture(&mut cmd, 120_000) else {
        return Err(AppError::with_detail(
            "analysis_failed",
            "yt-dlp could not be started.",
            format!("Failed to launch {} (check the Diagnostics screen).", ytdlp.display()),
        ));
    };
    let elapsed = start.elapsed();

    if raw.trim().is_empty() {
        return Err(AppError::with_detail(
            "analysis_failed",
            "yt-dlp produced no output for this URL.",
            format!("Command produced no output in {}ms.", elapsed.as_millis()),
        ));
    }

    let json: Value = match serde_json::from_str(raw.trim()) {
        Ok(v) => v,
        Err(e) => {
            return Err(AppError::with_detail(
                "analysis_failed",
                "yt-dlp could not extract this media.",
                format!("JSON parse error: {e}\nRaw output (first 800 chars):\n{}", &raw[..raw.len().min(800)]),
            ));
        }
    };

    crate::logger::info(
        "analyze_url",
        &format!("Analyzed {} ({})", redact_url(url), elapsed.as_millis()),
    );

    Ok(parse_result(&json))
}

/// Fetch just enough metadata for a single video (used when a queued raw URL
/// has no title yet). Returns the resolved url too so playlist item URLs resolve.
pub struct FetchedMedia {
    pub media: MediaInfo,
    pub url: String,
}

pub fn fetch_media(url: &str) -> AppResult<FetchedMedia> {
    let settings = AppSettings::load();
    let tools = resolve_all(&settings)?;

    let args = vec![
        "--dump-single-json".to_string(),
        "--no-playlist".to_string(),
        "--no-warnings".to_string(),
        "--quiet".to_string(),
        url.to_string(),
    ];
    let mut cmd = new_command(&tools.ytdlp);
    cmd.args(&args);
    let Some(raw) = run_capture(&mut cmd, 120_000) else {
        return Err(AppError::dependency("yt-dlp could not be started."));
    };
    let json: Value = serde_json::from_str(raw.trim()).map_err(|e| {
        AppError::analysis(
            "yt-dlp could not extract this media.",
            format!("JSON parse error: {e}\n{}", &raw[..raw.len().min(800)]),
        )
    })?;
    let media = parse_media(&json);
    let resolved_url = media
        .webpage_url
        .clone()
        .unwrap_or_else(|| url.to_string());
    Ok(FetchedMedia { media, url: resolved_url })
}

// Guard to keep `Path` import used in future helpers.
#[allow(dead_code)]
fn _ensure_path_used(_: &Path) {}
