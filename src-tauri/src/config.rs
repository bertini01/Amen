use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const APP_NAME: &str = "Amen";

/// Roaming config dir: %APPDATA%\Amen
pub fn app_data_dir() -> PathBuf {
    dirs::config_dir()
        .map(|d| d.join("Amen"))
        .unwrap_or_else(|| PathBuf::from("."))
}

pub fn logs_dir() -> PathBuf {
    app_data_dir().join("logs")
}

/// Bundled tools: %LOCALAPPDATA%\Amen\tools
pub fn tools_dir() -> PathBuf {
    dirs::data_local_dir()
        .map(|d| d.join("Amen").join("tools"))
        .unwrap_or_else(|| app_data_dir().join("tools"))
}

/// Studio preview renders and waveforms: %LOCALAPPDATA%\Amen\cache. Large
/// WAVs must not sit in the roaming profile, which is copied at sign-in and
/// sign-out on managed machines.
pub fn cache_dir() -> PathBuf {
    dirs::data_local_dir()
        .map(|d| d.join("Amen").join("cache"))
        .unwrap_or_else(|| app_data_dir().join("cache"))
}

/// Where older versions kept that cache (Roaming). Only ever deleted.
pub fn legacy_cache_dir() -> PathBuf {
    app_data_dir().join("cache")
}

/// The MSIX package family name when running as a packaged (Store) app.
#[cfg(windows)]
pub fn package_family_name() -> Option<String> {
    use std::sync::OnceLock;
    use windows_sys::Win32::Storage::Packaging::Appx::GetCurrentPackageFamilyName;
    static PFN: OnceLock<Option<String>> = OnceLock::new();
    PFN.get_or_init(|| package_string(GetCurrentPackageFamilyName)).clone()
}

#[cfg(not(windows))]
pub fn package_family_name() -> Option<String> {
    None
}

/// The packaged app's AppUserModelID (`<family>!<app id>`), which Windows
/// toasts from a packaged app must be sent under.
#[cfg(windows)]
pub fn package_app_user_model_id() -> Option<String> {
    use std::sync::OnceLock;
    use windows_sys::Win32::Storage::Packaging::Appx::GetCurrentApplicationUserModelId;
    static AUMID: OnceLock<Option<String>> = OnceLock::new();
    AUMID.get_or_init(|| package_string(GetCurrentApplicationUserModelId)).clone()
}

/// Call one of the `GetCurrent*` package-identity functions, which all take
/// (length, buffer) and fail with APPMODEL_ERROR_NO_PACKAGE when unpackaged.
#[cfg(windows)]
fn package_string(f: unsafe extern "system" fn(*mut u32, *mut u16) -> u32) -> Option<String> {
    use windows_sys::Win32::Foundation::ERROR_INSUFFICIENT_BUFFER;
    let mut len: u32 = 0;
    // SAFETY: a null buffer with length 0 only queries the needed length;
    // the second call gets a buffer of exactly that many u16s.
    unsafe {
        if f(&mut len, std::ptr::null_mut()) != ERROR_INSUFFICIENT_BUFFER {
            return None;
        }
        let mut buf = vec![0u16; len as usize];
        if f(&mut len, buf.as_mut_ptr()) != 0 {
            return None;
        }
        // `len` counts the terminating NUL.
        buf.truncate((len as usize).saturating_sub(1));
        Some(String::from_utf16_lossy(&buf)).filter(|s| !s.is_empty())
    }
}

/// The path another program (Explorer, a media player) must use to reach a
/// file this app created.
///
/// A packaged (MSIX) app's new files under %APPDATA% and %LOCALAPPDATA% are
/// redirected to %LOCALAPPDATA%\Packages\<family>\LocalCache\{Roaming,Local}.
/// The app itself sees them at the usual path, but Explorer sees the real
/// disk, where `%APPDATA%\Amen\logs` does not exist, so "Open logs folder"
/// failed. Folders that already existed before the package was installed are
/// used in place, hence the existence check. Unpackaged, this is the identity.
pub fn shell_visible_path(path: &Path) -> PathBuf {
    if let Some(pfn) = package_family_name() {
        if let (Some(roaming), Some(local)) = (dirs::config_dir(), dirs::data_local_dir()) {
            if let Some(real) = redirected_path(path, &roaming, &local, &pfn) {
                if real.exists() {
                    return real;
                }
            }
        }
    }
    path.to_path_buf()
}

/// Where MSIX file-system virtualization puts `path`, if it applies to it.
fn redirected_path(path: &Path, roaming: &Path, local: &Path, pfn: &str) -> Option<PathBuf> {
    let packages = local.join("Packages");
    if path.starts_with(&packages) {
        return None; // already a real package path
    }
    let cache = packages.join(pfn).join("LocalCache");
    if let Ok(rest) = path.strip_prefix(roaming) {
        return Some(cache.join("Roaming").join(rest));
    }
    if let Ok(rest) = path.strip_prefix(local) {
        return Some(cache.join("Local").join(rest));
    }
    None
}

pub fn default_output_dir() -> PathBuf {
    dirs::audio_dir()
        .map(|d| d.join("Amen"))
        .unwrap_or_else(|| PathBuf::from("."))
}

pub fn settings_path() -> PathBuf {
    app_data_dir().join("settings.json")
}

pub fn history_db_path() -> PathBuf {
    app_data_dir().join("history.db")
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AppSettings {
    pub theme: String,
    pub startup_behavior: String,
    pub default_format: String,
    pub default_quality: String,
    pub output_dir: String,
    pub filename_template: String,
    pub overwrite_behavior: String,
    pub duplicate_handling: String,
    pub embed_artwork: bool,
    pub embed_metadata: bool,
    pub ytdlp_path: String,
    pub ffmpeg_path: String,
    pub ffprobe_path: String,
    pub max_concurrent: usize,
    pub clipboard_monitor: bool,
    pub notify_on_complete: bool,
    /// Optional, deliberately user-provided cookies file (never harvested automatically).
    pub cookies_file: String,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            theme: "dark".to_string(),
            startup_behavior: "restore".to_string(),
            default_format: "mp3".to_string(),
            default_quality: "best".to_string(),
            output_dir: default_output_dir().to_string_lossy().to_string(),
            filename_template: "%(title)s.%(ext)s".to_string(),
            overwrite_behavior: "skip".to_string(),
            duplicate_handling: "skip".to_string(),
            embed_artwork: true,
            embed_metadata: true,
            ytdlp_path: String::new(),
            ffmpeg_path: String::new(),
            ffprobe_path: String::new(),
            max_concurrent: 3,
            clipboard_monitor: false,
            notify_on_complete: true,
            cookies_file: String::new(),
        }
    }
}

impl AppSettings {
    pub fn load() -> Self {
        let path = settings_path();
        if let Ok(text) = std::fs::read_to_string(&path) {
            if let Ok(mut s) = serde_json::from_str::<AppSettings>(&text) {
                s.normalize();
                return s;
            }
        }
        Self::default()
    }

    pub fn save(&self) -> crate::error::AppResult<()> {
        let path = settings_path();
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let text = serde_json::to_string_pretty(self)
            .map_err(|e| crate::error::AppError::config(e.to_string()))?;
        std::fs::write(&path, text).map_err(|e| crate::error::AppError::io("Saving settings", e))
    }

    pub fn normalize(&mut self) {
        if self.output_dir.trim().is_empty() {
            self.output_dir = default_output_dir().to_string_lossy().to_string();
        }
        if self.filename_template.trim().is_empty() {
            self.filename_template = "%(title)s.%(ext)s".to_string();
        }
        if self.max_concurrent == 0 {
            self.max_concurrent = 1;
        }
        self.max_concurrent = self.max_concurrent.min(8);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(windows)]
    fn msix_redirects_roaming_and_local_app_data() {
        let roaming = Path::new(r"C:\Users\u\AppData\Roaming");
        let local = Path::new(r"C:\Users\u\AppData\Local");
        let pfn = "Pub.AmenStudio_abc123";
        let cache = Path::new(r"C:\Users\u\AppData\Local\Packages\Pub.AmenStudio_abc123\LocalCache");
        assert_eq!(
            redirected_path(&roaming.join(r"Amen\logs"), roaming, local, pfn),
            Some(cache.join(r"Roaming\Amen\logs"))
        );
        assert_eq!(
            redirected_path(&local.join(r"Amen\cache\p.wav"), roaming, local, pfn),
            Some(cache.join(r"Local\Amen\cache\p.wav"))
        );
        // Not virtualized: user folders, and paths already inside Packages.
        assert_eq!(redirected_path(Path::new(r"C:\Users\u\Music\Amen"), roaming, local, pfn), None);
        assert_eq!(redirected_path(&cache.join(r"Roaming\Amen"), roaming, local, pfn), None);
    }

    #[test]
    fn unpackaged_paths_are_unchanged() {
        // Tests never run inside an MSIX package.
        assert_eq!(package_family_name(), None);
        let p = app_data_dir().join("logs");
        assert_eq!(shell_visible_path(&p), p);
    }

    #[test]
    fn cache_is_not_in_roaming_app_data() {
        let roaming = dirs::config_dir().unwrap();
        assert!(!cache_dir().starts_with(&roaming));
        assert!(cache_dir().ends_with(Path::new("Amen").join("cache")));
    }
}
