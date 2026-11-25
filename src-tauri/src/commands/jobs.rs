use crate::download::{DownloadManager, DownloadRequest, Job};
use crate::error::{AppError, AppResult};
use std::sync::Arc;
use tauri::State;

#[tauri::command]
pub fn start_download(
    state: State<'_, Arc<DownloadManager>>,
    request: DownloadRequest,
) -> AppResult<Job> {
    if !is_web_url(&request.url) {
        return Err(AppError::new("invalid_url", "Only http(s) links can be downloaded."));
    }
    state.submit(request)
}

/// Downloads only ever come from analysed web links. Anything else reaching
/// this command (a file path, a stray option) is refused before yt-dlp sees it.
fn is_web_url(url: &str) -> bool {
    let lower = url.trim().to_ascii_lowercase();
    (lower.starts_with("https://") || lower.starts_with("http://"))
        && !url.chars().any(char::is_control)
}

#[tauri::command]
pub fn cancel_download(state: State<'_, Arc<DownloadManager>>, id: String) -> AppResult<()> {
    state.cancel(&id)
}

#[tauri::command]
pub fn retry_download(state: State<'_, Arc<DownloadManager>>, id: String) -> AppResult<()> {
    state.retry(&id)
}

#[tauri::command]
pub fn remove_job(state: State<'_, Arc<DownloadManager>>, id: String) -> AppResult<()> {
    state.remove_job(&id)
}

#[tauri::command]
pub fn clear_completed_jobs(state: State<'_, Arc<DownloadManager>>) -> AppResult<()> {
    state.clear_completed()
}

#[tauri::command]
pub fn list_jobs(state: State<'_, Arc<DownloadManager>>) -> Vec<Job> {
    state.list_jobs()
}

#[tauri::command]
pub fn validate_output_dir(path: String) -> AppResult<()> {
    if path.trim().is_empty() {
        return Err(AppError::new("invalid_config", "The output directory cannot be empty."));
    }
    let expanded = crate::util::expand_env(&path);
    let dir = std::path::PathBuf::from(expanded);
    std::fs::create_dir_all(&dir).map_err(|e| {
        AppError::with_detail(
            "invalid_config",
            "The output directory cannot be created.",
            e.to_string(),
        )
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::is_web_url;

    #[test]
    fn only_web_links_can_be_downloaded() {
        assert!(is_web_url("https://www.youtube.com/watch?v=x"));
        assert!(is_web_url("HTTP://example.com/a"));
        assert!(!is_web_url("--exec calc.exe"));
        assert!(!is_web_url(r"C:\Windows\System32\calc.exe"));
        assert!(!is_web_url("file:///etc/passwd"));
        assert!(!is_web_url("https://x/\nrm"));
    }
}
