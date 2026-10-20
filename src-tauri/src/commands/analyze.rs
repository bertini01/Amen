use crate::analyze::AnalyzeResult;
use crate::error::{AppError, AppResult};

/// Trim and lightly normalize a user-provided URL before analysis.
/// This is a safety/UX step only — yt-dlp decides whether a URL is supported.
pub fn normalize_url(input: &str) -> String {
    input.trim().to_string()
}

#[tauri::command]
pub async fn analyze_url(url: String) -> AppResult<AnalyzeResult> {
    let url = normalize_url(&url);
    if url.is_empty() {
        return Err(AppError::new(
            "invalid_url",
            "Please paste a media URL first.",
        ));
    }
    if let Some(service) = crate::music_link::protected_service(&url) {
        return Err(AppError::with_detail(
            "protected_service",
            format!("{service} songs are copy-protected, so they can't be saved directly."),
            "Type the song name and artist instead. Amen will search for a version you can save.",
        ));
    }
    tauri::async_runtime::spawn_blocking(move || crate::analyze::analyze_url(&url, true))
        .await
        .map_err(|e| {
            AppError::with_detail("analysis_failed", "Media analysis was interrupted.", e.to_string())
        })?
}

/// Describe the songs behind a Spotify link so the user can find them on a
/// site that allows saving. See `music_link` for why the audio itself is off-limits.
#[tauri::command]
pub async fn resolve_music_link(url: String) -> AppResult<crate::music_link::MusicLink> {
    tauri::async_runtime::spawn_blocking(move || crate::music_link::resolve_spotify(&url))
        .await
        .map_err(|e| {
            AppError::with_detail("analysis_failed", "Looking up the link was interrupted.", e.to_string())
        })?
}
