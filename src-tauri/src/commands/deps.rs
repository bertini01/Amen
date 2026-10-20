use crate::config::AppSettings;
use crate::error::{AppError, AppResult};
use crate::tools::{self, DependencyReport, YtdlpUpdateInfo};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Emitter;

/// Set while an install or a yt-dlp self-update is writing into the tools
/// directory. Two at once raced on the same temporary and final files.
static TOOLS_BUSY: AtomicBool = AtomicBool::new(false);

/// Holds `TOOLS_BUSY` for as long as it lives, so the flag is released on
/// every exit path, including an error or a panicking install thread.
struct ToolsGuard(&'static AtomicBool);

impl ToolsGuard {
    fn acquire(flag: &'static AtomicBool) -> AppResult<Self> {
        flag.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .map(|_| Self(flag))
            .map_err(|_| {
                AppError::new(
                    "install_in_progress",
                    "An install is already running. Wait for it to finish and try again.",
                )
            })
    }
}

impl Drop for ToolsGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

#[tauri::command]
pub async fn detect_dependencies() -> AppResult<DependencyReport> {
    tauri::async_runtime::spawn_blocking(|| {
        let settings = AppSettings::load();
        Ok::<_, AppError>(tools::detect_dependencies(&settings))
    })
    .await
    .map_err(|e| AppError::with_detail("detect_failed", "Dependency detection failed.", e.to_string()))?
}

#[tauri::command]
pub async fn install_dependencies(
    app: tauri::AppHandle,
    what: String,
) -> AppResult<DependencyReport> {
    let what = what.trim().to_string();
    if !matches!(what.as_str(), "all" | "yt-dlp" | "ffmpeg") {
        return Err(AppError::new("invalid_request", "Unknown component to install."));
    }
    let guard = ToolsGuard::acquire(&TOOLS_BUSY)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        tools::install_dependencies(&what, |stage, percent, message| {
            let _ = app.emit(
                "install-progress",
                &serde_json::json!({
                    "stage": stage,
                    "percent": percent,
                    "message": message,
                }),
            );
        })
    })
    .await
    .map_err(|e| AppError::with_detail("install_failed", "Dependency install failed.", e.to_string()))?
}

#[tauri::command]
pub async fn check_ytdlp_update() -> AppResult<YtdlpUpdateInfo> {
    tauri::async_runtime::spawn_blocking(|| {
        let settings = AppSettings::load();
        tools::check_ytdlp_update(&settings)
    })
    .await
    .map_err(|e| AppError::with_detail("update_check_failed", "Update check failed.", e.to_string()))?
}

#[tauri::command]
pub async fn update_ytdlp() -> AppResult<String> {
    // The self-update rewrites the same yt-dlp.exe an install downloads.
    let guard = ToolsGuard::acquire(&TOOLS_BUSY)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        let settings = AppSettings::load();
        tools::update_ytdlp(&settings)
    })
    .await
    .map_err(|e| AppError::with_detail("update_failed", "Update failed.", e.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn second_install_is_refused_until_the_first_ends() {
        static FLAG: AtomicBool = AtomicBool::new(false);
        let first = ToolsGuard::acquire(&FLAG).expect("first install starts");
        let err = ToolsGuard::acquire(&FLAG).err().expect("second install refused");
        assert_eq!(err.code, "install_in_progress");
        assert!(err.message.contains("already running"));
        drop(first);
        assert!(ToolsGuard::acquire(&FLAG).is_ok());
    }

    #[test]
    fn guard_is_released_when_the_install_thread_panics() {
        static FLAG: AtomicBool = AtomicBool::new(false);
        let guard = ToolsGuard::acquire(&FLAG).unwrap();
        let _ = std::thread::spawn(move || {
            let _guard = guard;
            panic!("install blew up");
        })
        .join();
        assert!(ToolsGuard::acquire(&FLAG).is_ok());
    }
}
