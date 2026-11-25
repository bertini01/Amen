use crate::config::shell_visible_path;
use crate::error::{AppError, AppResult};
use std::path::PathBuf;

fn to_app_error(e: tauri_plugin_opener::Error) -> AppError {
    AppError::with_detail("open_failed", "Could not open the item.", e.to_string())
}

/// File types "Open" may hand to the default application. Opening launches
/// whatever Windows associates with the file, so an executable, script or
/// shortcut would RUN: only media, images, logs and Studio projects qualify.
const OPENABLE_EXTENSIONS: &[&str] = &[
    "mp3", "m4a", "aac", "ogg", "opus", "flac", "wav", "wma", "mp4", "m4v", "mkv", "webm",
    "mov", "avi", "jpg", "jpeg", "png", "webp", "gif", "txt", "log", "lms",
];

fn is_openable(path: &std::path::Path) -> bool {
    path.extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .is_some_and(|e| OPENABLE_EXTENSIONS.contains(&e.as_str()))
}

/// Open a file with its default application.
#[tauri::command]
pub fn open_file(app: tauri::AppHandle, path: String) -> AppResult<()> {
    use tauri_plugin_opener::OpenerExt;
    let p = std::path::PathBuf::from(&path);
    if !p.exists() {
        return Err(AppError::new("not_found", "The file no longer exists."));
    }
    if !p.is_file() {
        return Err(AppError::new("not_file", "The path is not a file."));
    }
    if !is_openable(&p) {
        return Err(AppError::new(
            "not_openable",
            "Amply Studio only opens audio, video, image and project files.",
        ));
    }
    // The default app runs outside the MSIX package and sees the real disk.
    let real = shell_visible_path(&p);
    app.opener()
        .open_path(real.to_string_lossy(), None::<&str>)
        .map_err(to_app_error)
}

/// Open a folder in Explorer.
#[tauri::command]
pub fn open_folder(app: tauri::AppHandle, path: String) -> AppResult<()> {
    use tauri_plugin_opener::OpenerExt;
    let p = PathBuf::from(&path);
    if p.is_dir() {
        // Explorer sees the real disk, not the package's redirected AppData.
        let real = shell_visible_path(&p);
        app.opener()
            .open_path(real.to_string_lossy(), None::<&str>)
            .map_err(to_app_error)
    } else {
        Err(AppError::new("open_failed", "That folder does not exist."))
    }
}

/// Reveal/select a file in Windows Explorer.
#[tauri::command]
pub fn reveal_in_folder(app: tauri::AppHandle, path: String) -> AppResult<()> {
    use tauri_plugin_opener::OpenerExt;
    let p = std::path::PathBuf::from(&path);
    if !p.exists() {
        return Err(AppError::new("not_found", "The file no longer exists on disk."));
    }
    let real = shell_visible_path(&p);
    let path = real.to_string_lossy().to_string();

    // Fallback: On some versions of Windows, reveal_item_in_dir might fail for network/mapped drives.
    // We try the plugin first, and if it fails, we fall back to a direct Command.
    match app.opener().reveal_item_in_dir(&path) {
        Ok(_) => Ok(()),
        Err(e) => {
            #[cfg(windows)]
            {
                // Try explicit explorer.exe /select,"path"
                if let Ok(mut cmd) = std::process::Command::new("explorer.exe")
                    .arg("/select,")
                    .arg(&path)
                    .spawn()
                {
                    let _ = cmd.wait();
                    return Ok(());
                }
            }
            #[cfg(not(windows))]
            {
                // No portable "select this file" on Linux desktops, so open the
                // containing directory — the file manager lands the user in the
                // right place, which is the point of the gesture.
                if let Some(dir) = p.parent() {
                    if let Ok(mut cmd) = std::process::Command::new("xdg-open").arg(dir).spawn() {
                        let _ = cmd.wait();
                        return Ok(());
                    }
                }
            }
            Err(to_app_error(e))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::is_openable;
    use std::path::Path;

    #[test]
    fn opens_media_but_never_programs() {
        assert!(is_openable(Path::new("song.MP3")));
        assert!(is_openable(Path::new("mix.lms")));
        for bad in ["setup.exe", "run.bat", "x.cmd", "y.ps1", "z.lnk", "a.msi", "b.scr", "c.js", "d.vbs", "noext"] {
            assert!(!is_openable(Path::new(bad)), "{bad}");
        }
    }
}
