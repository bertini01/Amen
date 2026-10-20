use crate::config::shell_visible_path;
use crate::error::{AppError, AppResult};
use std::path::PathBuf;

fn to_app_error(e: tauri_plugin_opener::Error) -> AppError {
    AppError::with_detail("open_failed", "Could not open the item.", e.to_string())
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
