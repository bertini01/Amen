use crate::download::DownloadManager;
use crate::error::{AppError, AppResult};
use crate::history::HistoryItem;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::State;

/// Async + blocking pool: the repair below touches the disk for every entry
/// whose file is missing, which must not stall the main (UI) thread.
#[tauri::command]
pub async fn get_history(
    state: State<'_, Arc<DownloadManager>>,
    query: Option<String>,
    format_filter: Option<String>,
    status_filter: Option<String>,
    sort: Option<String>,
) -> AppResult<Vec<HistoryItem>> {
    let manager = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        list_and_repair(&manager, query, format_filter, status_filter, sort)
    })
    .await
    .map_err(|e| AppError::with_detail("db_error", "Could not load history.", e.to_string()))?
}

fn list_and_repair(
    manager: &DownloadManager,
    query: Option<String>,
    format_filter: Option<String>,
    status_filter: Option<String>,
    sort: Option<String>,
) -> AppResult<Vec<HistoryItem>> {
    let db = manager.history_db();
    let mut items = db.list_history(
        query.as_deref(),
        format_filter.as_deref(),
        status_filter.as_deref(),
        sort.as_deref().unwrap_or("date"),
    )?;
    // Older versions recorded wrong paths for titles with emoji or a slash
    // (the file exists, under a slightly different name). Repair those
    // entries in place so Open, Show in folder and Open in Audio Studio work.
    for item in items.iter_mut() {
        if item.status != "completed" || item.file_path.is_empty() {
            continue;
        }
        if Path::new(&item.file_path).exists() {
            continue;
        }
        if let Some(found) = find_renamed_file(Path::new(&item.file_path)) {
            let found = found.to_string_lossy().to_string();
            if db.update_file_path(&item.id, &found).is_ok() {
                item.file_path = found;
            }
        }
    }
    Ok(items)
}

/// Letters and digits only, lowercased: the part of a filename that survives
/// whichever characters (emoji, punctuation, spacing) were lost or changed.
fn name_key(name: &str) -> String {
    name.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(|c| c.to_lowercase())
        .collect()
}

/// Look for the file a stale history path meant: same folder, same extension,
/// same name once emoji and punctuation are ignored. Returns a match only when
/// it is unambiguous.
fn find_renamed_file(missing: &Path) -> Option<PathBuf> {
    let dir = missing.parent()?;
    let ext = missing.extension()?.to_string_lossy().to_lowercase();
    let key = name_key(&missing.file_stem()?.to_string_lossy());
    if key.is_empty() {
        return None;
    }
    let mut matches = std::fs::read_dir(dir)
        .ok()?
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| {
            p.is_file()
                && p.extension().map(|e| e.to_string_lossy().to_lowercase()) == Some(ext.clone())
                && p.file_stem().map(|s| name_key(&s.to_string_lossy())) == Some(key.clone())
        });
    let first = matches.next()?;
    if matches.next().is_some() {
        return None;
    }
    Some(first)
}

#[tauri::command]
pub fn remove_history_item(state: State<'_, Arc<DownloadManager>>, id: String) -> AppResult<()> {
    state.history_db().remove_history(&id)
}

#[tauri::command]
pub fn clear_history(state: State<'_, Arc<DownloadManager>>) -> AppResult<()> {
    state.history_db().clear_history()
}

/// What a folder tidy-up did (or, in a preview, would do).
#[derive(Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TidyReport {
    /// Songs found in accidental sub-folders.
    pub found: usize,
    pub moved: usize,
    pub failed: Vec<String>,
    pub removed_folders: usize,
}

/// Older versions turned a "/" in a song title into folders
/// ("EP 18 / Song" saved as "EP 18\Song.mp3"). Move such downloads back into
/// the output folder under their full name and update History. With
/// `preview` nothing is changed; the report only counts what would move.
#[tauri::command]
pub async fn tidy_download_folders(
    state: State<'_, Arc<DownloadManager>>,
    preview: bool,
) -> AppResult<TidyReport> {
    let manager = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || tidy(&manager, preview))
        .await
        .map_err(|e| AppError::with_detail("tidy_failed", "Tidying up was interrupted.", e.to_string()))?
}

fn tidy(manager: &DownloadManager, preview: bool) -> AppResult<TidyReport> {
    let settings = crate::config::AppSettings::load();
    // A template that itself contains folders means nested files are intended.
    if settings.filename_template.contains(['/', '\\']) {
        return Ok(TidyReport::default());
    }
    let root = PathBuf::from(crate::util::expand_env(&settings.output_dir));
    let db = manager.history_db();
    let mut report = TidyReport::default();
    let mut emptied: Vec<PathBuf> = Vec::new();

    for item in db.list_history(None, None, None, "date")? {
        let Some(name) = flattened_name(&root, Path::new(&item.file_path)) else {
            continue;
        };
        report.found += 1;
        if preview {
            continue;
        }
        let from = PathBuf::from(&item.file_path);
        let ext = from.extension().map(|e| e.to_string_lossy().to_string()).unwrap_or_default();
        let fields = std::collections::HashMap::from([("title".to_string(), name)]);
        let target = crate::util::build_output_path(&root.to_string_lossy(), "%(title)s.%(ext)s", &fields, &ext)
            .map(|p| crate::util::unique_path(&p));
        let result = target.and_then(|to| {
            std::fs::rename(&from, &to).map_err(|e| AppError::io("Moving a download", e))?;
            db.update_file_path(&item.id, &to.to_string_lossy())?;
            Ok(())
        });
        match result {
            Ok(()) => {
                report.moved += 1;
                emptied.extend(from.ancestors().skip(1).take_while(|d| *d != root).map(Path::to_path_buf));
            }
            Err(e) => report.failed.push(format!("{}: {}", item.title.unwrap_or(item.file_path), e.message)),
        }
    }

    // Deepest first; remove_dir only succeeds on folders that are now empty,
    // so anything else the user keeps there is left alone.
    emptied.sort_by_key(|d| std::cmp::Reverse(d.components().count()));
    emptied.dedup();
    for dir in emptied {
        if std::fs::remove_dir(&dir).is_ok() {
            report.removed_folders += 1;
        }
    }
    Ok(report)
}

/// The full title of a download that sits in sub-folders of `root`
/// ("A/B/C.mp3" -> "A - B - C"), or None when it is already directly inside
/// `root`, outside it, or missing.
fn flattened_name(root: &Path, file: &Path) -> Option<String> {
    if !file.is_file() {
        return None;
    }
    let relative = file.strip_prefix(root).ok()?;
    let parts: Vec<String> = relative.components().map(|c| c.as_os_str().to_string_lossy().to_string()).collect();
    if parts.len() < 2 {
        return None;
    }
    let (last, dirs) = parts.split_last()?;
    let stem = Path::new(last).file_stem()?.to_string_lossy().to_string();
    Some(dirs.iter().cloned().chain(std::iter::once(stem)).collect::<Vec<_>>().join(" - "))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_file_whose_emoji_were_dropped_from_the_record() {
        let dir = std::env::temp_dir().join(format!("amen-heal-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let real = dir.join("TUZAVOMAYO IBYIZA 🙏🙏.mp3");
        std::fs::write(&real, b"x").unwrap();
        let recorded = dir.join("TUZAVOMAYO IBYIZA .mp3");
        assert_eq!(find_renamed_file(&recorded), Some(real));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn ignores_ambiguous_or_different_files() {
        let dir = std::env::temp_dir().join(format!("amen-heal-amb-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("Song 🙂.mp3"), b"x").unwrap();
        std::fs::write(dir.join("Song!.mp3"), b"x").unwrap();
        std::fs::write(dir.join("Other.mp3"), b"x").unwrap();
        assert_eq!(find_renamed_file(&dir.join("Song.mp3")), None);
        assert_eq!(find_renamed_file(&dir.join("Missing.mp3")), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn flattens_only_downloads_inside_sub_folders() {
        let root = std::env::temp_dir().join(format!("amen-tidy-{}", std::process::id()));
        let nested = root.join("IGITRAMO EP 18 BONNE ANNE").join("UMURIRO URATSE");
        std::fs::create_dir_all(&nested).unwrap();
        let deep = nested.join("CIKAKMO WA NYANJA WE.mp3");
        let flat = root.join("Song.mp3");
        std::fs::write(&deep, b"x").unwrap();
        std::fs::write(&flat, b"x").unwrap();
        assert_eq!(
            flattened_name(&root, &deep).as_deref(),
            Some("IGITRAMO EP 18 BONNE ANNE - UMURIRO URATSE - CIKAKMO WA NYANJA WE")
        );
        assert_eq!(flattened_name(&root, &flat), None);
        assert_eq!(flattened_name(&root, &root.join("missing").join("x.mp3")), None);
        assert_eq!(flattened_name(&nested, &std::env::temp_dir().join("elsewhere.mp3")), None);
        let _ = std::fs::remove_dir_all(&root);
    }
}
