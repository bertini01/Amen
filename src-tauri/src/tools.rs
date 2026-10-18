use crate::config::{self, AppSettings};
use crate::error::{AppError, AppResult};
use crate::process::{new_command, run_capture};
use serde::Serialize;
use std::io::{Read, Write};
use std::net::ToSocketAddrs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolInfo {
    pub name: String,
    pub found: bool,
    pub version: Option<String>,
    pub path: Option<String>,
    pub source: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirCheck {
    pub ok: bool,
    pub path: String,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskCheck {
    pub ok: bool,
    pub path: String,
    pub free_bytes: u64,
    pub required_bytes: u64,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkCheck {
    pub ok: bool,
    pub error: Option<String>,
    pub latency_ms: Option<u64>,
    pub host: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DependencyReport {
    pub ytdlp: ToolInfo,
    pub ffmpeg: ToolInfo,
    pub ffprobe: ToolInfo,
    pub output_dir: DirCheck,
    pub disk_space: DiskCheck,
    pub network: NetworkCheck,
    pub tools_dir: String,
    pub python: Option<String>,
}

/// The bundled-tool filename for this platform: `ffmpeg.exe` on Windows,
/// plain `ffmpeg` everywhere else.
pub fn tool_file_name(stem: &str) -> String {
    format!("{stem}{}", std::env::consts::EXE_SUFFIX)
}

/// Search PATH for an executable.
fn search_path(program: &str) -> Option<PathBuf> {
    // Only Windows resolves a bare name through a list of extensions; on Unix
    // the file is named exactly what you asked for and carries an exec bit.
    let exts: &[&str] = if program.contains('.') || !cfg!(windows) {
        &[""]
    } else {
        &["", ".exe", ".cmd", ".bat", ".py"]
    };
    if let Some(paths) = std::env::var_os("PATH") {
        // `split_paths` uses the platform separator — ';' on Windows, ':' on
        // Unix. Splitting on ';' unconditionally meant that on Linux the whole
        // PATH was treated as one nonsensical directory and NOTHING was ever
        // found, so every tool looked missing however it had been installed.
        for dir in std::env::split_paths(&paths) {
            if dir.as_os_str().is_empty() {
                continue;
            }
            for ext in exts {
                let candidate = dir.join(format!("{program}{ext}"));
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
    }
    None
}

pub fn resolve_ytdlp(settings: &AppSettings) -> Option<PathBuf> {
    if !settings.ytdlp_path.trim().is_empty() {
        let p = PathBuf::from(settings.ytdlp_path.trim());
        if p.is_file() {
            return Some(p);
        }
    }
    let bundled = config::tools_dir().join(tool_file_name("yt-dlp"));
    if bundled.is_file() {
        return Some(bundled);
    }
    search_path("yt-dlp")
}

pub fn resolve_ffmpeg(settings: &AppSettings) -> Option<PathBuf> {
    if !settings.ffmpeg_path.trim().is_empty() {
        let p = PathBuf::from(settings.ffmpeg_path.trim());
        if p.is_file() {
            return Some(p);
        }
    }
    let bundled = config::tools_dir().join(tool_file_name("ffmpeg"));
    if bundled.is_file() {
        return Some(bundled);
    }
    search_path("ffmpeg")
}

pub fn resolve_ffprobe(settings: &AppSettings) -> Option<PathBuf> {
    if !settings.ffprobe_path.trim().is_empty() {
        let p = PathBuf::from(settings.ffprobe_path.trim());
        if p.is_file() {
            return Some(p);
        }
    }
    let bundled = config::tools_dir().join(tool_file_name("ffprobe"));
    if bundled.is_file() {
        return Some(bundled);
    }
    search_path("ffprobe")
}

/// Resolved tools used by download/analyze commands.
#[derive(Debug, Clone)]
pub struct ResolvedTools {
    pub ytdlp: PathBuf,
    // ffmpeg/ffprobe are read by the real end-to-end integration tests
    #[allow(dead_code)]
    pub ffmpeg: Option<PathBuf>,
    #[allow(dead_code)]
    pub ffprobe: Option<PathBuf>,
    pub ffmpeg_dir: Option<PathBuf>,
}

pub fn resolve_all(settings: &AppSettings) -> AppResult<ResolvedTools> {
    let ytdlp = resolve_ytdlp(settings)
        .ok_or_else(|| AppError::dependency("yt-dlp is not installed. Open Diagnostics to install it."))?;
    let ffmpeg = resolve_ffmpeg(settings);
    let ffprobe = resolve_ffprobe(settings);
    let ffmpeg_dir = ffmpeg.as_ref().and_then(|p| p.parent().map(|d| d.to_path_buf()));
    Ok(ResolvedTools {
        ytdlp,
        ffmpeg,
        ffprobe,
        ffmpeg_dir,
    })
}

fn run_version(exe: &Path, args: &[&str]) -> Option<String> {
    let is_py = exe
        .extension()
        .map(|e| e.eq_ignore_ascii_case("py"))
        .unwrap_or(false);
    let mut cmd = if is_py {
        let mut c = new_command(Path::new("py"));
        c.arg("-3").arg(exe);
        c
    } else {
        new_command(exe)
    };
    cmd.args(args);
    let out = run_capture(&mut cmd, 20_000)?;
    let first = out.lines().next()?.trim().to_string();
    if first.is_empty() {
        None
    } else {
        Some(first)
    }
}

pub fn probe_ytdlp_version(exe: &Path) -> Option<String> {
    run_version(exe, &["--version"])
}

pub fn probe_ffmpeg_version(exe: &Path) -> Option<String> {
    run_version(exe, &["-version"]).and_then(|v| v.split("Copyright").next().map(|s| s.trim().to_string()))
}

pub fn probe_ffprobe_version(exe: &Path) -> Option<String> {
    run_version(exe, &["-version"]).and_then(|v| v.split("Copyright").next().map(|s| s.trim().to_string()))
}

fn check_dir_writable(path: &Path) -> Result<(), String> {
    std::fs::create_dir_all(path).map_err(|e| e.to_string())?;
    let probe = path.join(".lms_write_test");
    std::fs::write(&probe, b"ok").map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(&probe);
    Ok(())
}

#[cfg(windows)]
pub fn free_disk_space(path: &Path) -> Option<u64> {
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    let wide: Vec<u16> = path
        .to_string_lossy()
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let mut free: u64 = 0;
    let mut total: u64 = 0;
    // SAFETY: wide is a valid null-terminated wide string
    unsafe {
        let ok = GetDiskFreeSpaceExW(wide.as_ptr(), &mut free, &mut total, std::ptr::null_mut());
        if ok != 0 {
            Some(free)
        } else {
            None
        }
    }
}

/// Free space on the filesystem holding `path`, via the mounted-disk list.
///
/// Unix has no direct equivalent of `GetDiskFreeSpaceExW` in this crate's
/// dependency set, so the filesystem is identified by the LONGEST mount point
/// that is a prefix of the path — on Linux `/home` and `/` are both prefixes of
/// `/home/user/x`, and only the longest one describes the right device.
#[cfg(not(windows))]
pub fn free_disk_space(path: &Path) -> Option<u64> {
    use sysinfo::Disks;
    // Resolve symlinks/.. so prefix matching compares real mount paths; fall
    // back to the nearest existing ancestor for a directory not yet created.
    let target = path
        .canonicalize()
        .or_else(|_| {
            path.ancestors()
                .find(|a| a.exists())
                .map(|a| a.to_path_buf())
                .ok_or_else(|| std::io::Error::from(std::io::ErrorKind::NotFound))
                .and_then(|a| a.canonicalize())
        })
        .ok()?;

    let disks = Disks::new_with_refreshed_list();
    disks
        .list()
        .iter()
        .filter(|d| target.starts_with(d.mount_point()))
        .max_by_key(|d| d.mount_point().as_os_str().len())
        .map(|d| d.available_space())
}

fn check_network() -> NetworkCheck {
    let hosts: [(&str, u16); 3] = [
        ("github.com", 443),
        ("www.gstatic.com", 443),
        ("www.youtube.com", 443),
    ];
    let mut last_error: Option<String> = None;
    for (host, port) in hosts {
        let start = Instant::now();
        // `SocketAddr::parse` only accepts IP literals, so a hostname has to go
        // through DNS first; parsing it directly made this check always fail.
        let addr = match (host, port).to_socket_addrs().ok().and_then(|mut a| a.next()) {
            Some(addr) => addr,
            None => {
                last_error = Some(format!("could not resolve {host}"));
                continue;
            }
        };
        match std::net::TcpStream::connect_timeout(&addr, Duration::from_secs(5)) {
            Ok(_) => {
                return NetworkCheck {
                    ok: true,
                    error: None,
                    latency_ms: Some(start.elapsed().as_millis() as u64),
                    host: Some(host.to_string()),
                };
            }
            Err(e) => last_error = Some(e.to_string()),
        }
    }
    NetworkCheck {
        ok: false,
        error: last_error,
        latency_ms: None,
        host: None,
    }
}

pub fn detect_dependencies(settings: &AppSettings) -> DependencyReport {
    let ytdlp_exe = resolve_ytdlp(settings);
    let ffmpeg_exe = resolve_ffmpeg(settings);
    let ffprobe_exe = resolve_ffprobe(settings);

    let ytdlp = if let Some(exe) = &ytdlp_exe {
        let version = probe_ytdlp_version(exe);
        ToolInfo {
            name: "yt-dlp".to_string(),
            found: true,
            version,
            path: Some(exe.to_string_lossy().to_string()),
            source: source_label(settings, exe, "yt-dlp"),
        }
    } else {
        ToolInfo {
            name: "yt-dlp".to_string(),
            found: false,
            version: None,
            path: None,
            source: "not found".to_string(),
        }
    };

    let ffmpeg = if let Some(exe) = &ffmpeg_exe {
        ToolInfo {
            name: "ffmpeg".to_string(),
            found: true,
            version: probe_ffmpeg_version(exe),
            path: Some(exe.to_string_lossy().to_string()),
            source: source_label(settings, exe, "ffmpeg"),
        }
    } else {
        ToolInfo {
            name: "ffmpeg".to_string(),
            found: false,
            version: None,
            path: None,
            source: "not found".to_string(),
        }
    };

    let ffprobe = if let Some(exe) = &ffprobe_exe {
        ToolInfo {
            name: "ffprobe".to_string(),
            found: true,
            version: probe_ffprobe_version(exe),
            path: Some(exe.to_string_lossy().to_string()),
            source: source_label(settings, exe, "ffprobe"),
        }
    } else {
        ToolInfo {
            name: "ffprobe".to_string(),
            found: false,
            version: None,
            path: None,
            source: "not found".to_string(),
        }
    };

    let output_dir_path = PathBuf::from(crate::util::expand_env(&settings.output_dir));
    let output_dir = match check_dir_writable(&output_dir_path) {
        Ok(_) => DirCheck {
            ok: true,
            path: output_dir_path.to_string_lossy().to_string(),
            error: None,
        },
        Err(e) => DirCheck {
            ok: false,
            path: output_dir_path.to_string_lossy().to_string(),
            error: Some(e),
        },
    };

    let free_bytes = free_disk_space(&output_dir_path).unwrap_or(0);
    let disk_space = DiskCheck {
        ok: free_bytes > 512 * 1024 * 1024, // > 512 MB is a sane minimum
        path: output_dir_path.to_string_lossy().to_string(),
        free_bytes,
        required_bytes: 512 * 1024 * 1024,
        error: if free_bytes == 0 {
            Some("could not determine free disk space".to_string())
        } else if free_bytes <= 512 * 1024 * 1024 {
            Some("low disk space on the output drive".to_string())
        } else {
            None
        },
    };

    let network = check_network();

    let python = std::env::var("PATH")
        .ok()
        .and_then(|_| {
            let py = search_path("py");
            py.map(|p| p.to_string_lossy().to_string())
        })
        .or_else(|| {
            std::env::var("PYTHON").ok().filter(|p| !p.is_empty())
        });

    DependencyReport {
        ytdlp,
        ffmpeg,
        ffprobe,
        output_dir,
        disk_space,
        network,
        tools_dir: config::tools_dir().to_string_lossy().to_string(),
        python,
    }
}

fn source_label(settings: &AppSettings, exe: &Path, name: &str) -> String {
    let exe_str = exe.to_string_lossy().to_lowercase();
    let configured = match name {
        "yt-dlp" => &settings.ytdlp_path,
        "ffmpeg" => &settings.ffmpeg_path,
        _ => &settings.ffprobe_path,
    };
    if !configured.trim().is_empty() {
        "Configured path".to_string()
    } else if exe_str.starts_with(&config::tools_dir().to_string_lossy().to_lowercase()) {
        "Bundled".to_string()
    } else {
        "System PATH".to_string()
    }
}

// ---------- Installation ----------

#[cfg(windows)]
pub const YTDLP_DOWNLOAD_URL: &str =
    "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe";
/// The official self-contained Linux build from the same release. Named
/// `yt-dlp_linux` upstream; it is saved locally as plain `yt-dlp`.
#[cfg(all(unix, not(target_os = "macos")))]
pub const YTDLP_DOWNLOAD_URL: &str =
    "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux";
#[cfg(target_os = "macos")]
pub const YTDLP_DOWNLOAD_URL: &str =
    "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos";

#[cfg(windows)]
pub const FFMPEG_DOWNLOAD_URL: &str = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip";

/// Give a freshly downloaded tool its exec bit. A no-op on Windows, where
/// executability comes from the file extension rather than a mode bit.
fn make_executable(path: &Path) -> AppResult<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(path)
            .map_err(|e| AppError::io("Reading downloaded tool", e))?
            .permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(path, perms)
            .map_err(|e| AppError::io("Making the downloaded tool executable", e))?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

fn http_download(
    url: &str,
    dest: &Path,
    on_progress: impl Fn(u64, u64),
) -> AppResult<()> {
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(30))
        .timeout_read(Duration::from_secs(60))
        .user_agent("LocalMediaStudio/0.1")
        .build();
    let resp = agent
        .get(url)
        .call()
        .map_err(|e| AppError::with_detail("download_failed", "Failed to download the file.", e.to_string()))?;
    let total = resp
        .header("Content-Length")
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(0);
    let mut reader = resp.into_reader();
    let mut file = std::fs::File::create(dest)
        .map_err(|e| AppError::io("Creating download file", e))?;
    let mut buf = [0u8; 128 * 1024];
    let mut written: u64 = 0;
    loop {
        let n = reader
            .read(&mut buf)
            .map_err(|e| AppError::with_detail("download_failed", "Download interrupted.", e.to_string()))?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n])
            .map_err(|e| AppError::io("Writing download", e))?;
        written += n as u64;
        on_progress(written, total);
    }
    file.flush().map_err(|e| AppError::io("Flushing download", e))?;
    Ok(())
}

/// Install yt-dlp and FFmpeg into the app's tools directory.
/// Progress is reported through the `on_event` callback: (stage, percent, message).
pub fn install_dependencies(
    what: &str,
    on_event: impl Fn(&str, Option<u64>, &str),
) -> AppResult<DependencyReport> {
    let tools = config::tools_dir();
    std::fs::create_dir_all(&tools).map_err(|e| AppError::io("Creating tools directory", e))?;

    if what == "yt-dlp" || what == "all" {
        on_event("yt-dlp", None, "Downloading yt-dlp from the official GitHub releases…");
        let tmp = tools.join("yt-dlp.download");
        let _ = std::fs::remove_file(&tmp);
        http_download(YTDLP_DOWNLOAD_URL, &tmp, |done, total| {
            let pct = if total > 0 {
                Some((done as f64 / total as f64 * 100.0) as u64)
            } else {
                None
            };
            on_event("yt-dlp", pct, "Downloading yt-dlp…");
        })?;
        let dest = tools.join(tool_file_name("yt-dlp"));
        std::fs::rename(&tmp, &dest)
            .map_err(|e| AppError::io("Finalizing yt-dlp install", e))?;
        // On Unix a downloaded file arrives without its exec bit, so without
        // this the install "succeeds" and every later invocation fails.
        make_executable(&dest)?;
        on_event("yt-dlp", Some(100), "yt-dlp installed");
    }

    // FFmpeg ships as a prebuilt archive on Windows. On Linux it comes from the
    // distribution instead (the .deb depends on it), so there is no archive to
    // fetch — say so plainly rather than downloading a Windows .zip that could
    // never run here.
    #[cfg(not(windows))]
    if what == "ffmpeg" {
        return Err(AppError::with_detail(
            "unsupported_platform",
            "Install FFmpeg with your package manager.",
            "On Linux, Amen uses the system FFmpeg. Install it with `sudo apt install ffmpeg` \
             (Debian/Ubuntu) or your distribution's equivalent, then run this check again."
                .to_string(),
        ));
    }

    #[cfg(windows)]
    if what == "ffmpeg" || what == "all" {
        on_event("ffmpeg", None, "Downloading FFmpeg (official Windows build from gyan.dev)…");
        let zip_path = tools.join("ffmpeg.zip");
        let _ = std::fs::remove_file(&zip_path);
        http_download(FFMPEG_DOWNLOAD_URL, &zip_path, |done, total| {
            let pct = if total > 0 {
                Some((done as f64 / total as f64 * 100.0) as u64)
            } else {
                None
            };
            on_event("ffmpeg", pct, "Downloading FFmpeg…");
        })?;
        on_event("ffmpeg", None, "Extracting FFmpeg…");
        extract_ffmpeg(&zip_path, &tools)?;
        let _ = std::fs::remove_file(&zip_path);
        on_event("ffmpeg", Some(100), "FFmpeg installed");
    }

    let settings = config::AppSettings::load();
    Ok(detect_dependencies(&settings))
}

/// Unpacks the Windows FFmpeg release zip. Windows-only: the archive it reads
/// contains PE binaries, and nothing calls this on other platforms.
#[cfg(windows)]
fn extract_ffmpeg(zip_path: &Path, tools: &Path) -> AppResult<()> {
    let file = std::fs::File::open(zip_path).map_err(|e| AppError::io("Opening FFmpeg archive", e))?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|e| AppError::with_detail("extract_failed", "Invalid FFmpeg archive.", e.to_string()))?;

    let mut found = 0usize;
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| AppError::with_detail("extract_failed", "Corrupt FFmpeg archive.", e.to_string()))?;
        let name = entry.name().replace('\\', "/");
        let base = name.rsplit('/').next().unwrap_or("").to_string();
        let lower = base.to_lowercase();
        let target = match lower.as_str() {
            "ffmpeg.exe" => Some(tools.join("ffmpeg.exe")),
            "ffprobe.exe" => Some(tools.join("ffprobe.exe")),
            _ => None,
        };
        if let Some(dest) = target {
            let mut out = std::fs::File::create(&dest)
                .map_err(|e| AppError::io("Writing FFmpeg binary", e))?;
            std::io::copy(&mut entry, &mut out)
                .map_err(|e| AppError::io("Writing FFmpeg binary", e))?;
            found += 1;
        }
    }
    if found < 2 {
        return Err(AppError::with_detail(
            "extract_failed",
            "Could not find ffmpeg/ffprobe inside the downloaded archive.",
            "The archive did not contain the expected binaries.",
        ));
    }
    Ok(())
}

/// Check for a newer yt-dlp release using the official GitHub API.
pub fn check_ytdlp_update(settings: &AppSettings) -> AppResult<YtdlpUpdateInfo> {
    let Some(exe) = resolve_ytdlp(settings) else {
        return Err(AppError::dependency("yt-dlp is not installed."));
    };
    let current = probe_ytdlp_version(&exe).unwrap_or_else(|| "unknown".to_string());
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(15))
        .timeout_read(Duration::from_secs(30))
        .user_agent("LocalMediaStudio/0.1")
        .build();
    let resp = agent
        .get("https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest")
        .call()
        .map_err(|e| {
            AppError::with_detail("update_check_failed", "Could not reach the update server.", e.to_string())
        })?;
    let body: serde_json::Value = resp
        .into_json()
        .map_err(|e| AppError::with_detail("update_check_failed", "Bad response from update server.", e.to_string()))?;
    let latest = body
        .get("tag_name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim_start_matches('v')
        .to_string();

    let update_available = !latest.is_empty()
        && current != "unknown"
        && version_newer(&latest, &current);

    Ok(YtdlpUpdateInfo {
        current,
        latest,
        update_available,
        bundled: exe.to_string_lossy().to_string(),
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct YtdlpUpdateInfo {
    pub current: String,
    pub latest: String,
    pub update_available: bool,
    pub bundled: String,
}

/// Simple dotted-version comparison (yt-dlp versions are dates like 2025.01.26).
fn version_newer(a: &str, b: &str) -> bool {
    let pa: Vec<u64> = a.split('.').filter_map(|s| s.parse().ok()).collect();
    let pb: Vec<u64> = b.split('.').filter_map(|s| s.parse().ok()).collect();
    let len = pa.len().max(pb.len());
    for i in 0..len {
        let va = pa.get(i).copied().unwrap_or(0);
        let vb = pb.get(i).copied().unwrap_or(0);
        if va != vb {
            return va > vb;
        }
    }
    false
}

/// Update the bundled yt-dlp using its own self-update mechanism (official).
pub fn update_ytdlp(settings: &AppSettings) -> AppResult<String> {
    let Some(exe) = resolve_ytdlp(settings) else {
        return Err(AppError::dependency("yt-dlp is not installed."));
    };
    let bundled = exe
        .to_string_lossy()
        .to_lowercase()
        .starts_with(&config::tools_dir().to_string_lossy().to_lowercase());
    if !bundled {
        return Err(AppError::with_detail(
            "update_unsupported",
            "Only the bundled copy of yt-dlp can be auto-updated.",
            "To update a system-wide yt-dlp, use pip or your package manager.",
        ));
    }
    let mut cmd = new_command(&exe);
    cmd.arg("-U");
    let out = run_capture(&mut cmd, 120_000).ok_or_else(|| {
        AppError::with_detail("update_failed", "Could not run the yt-dlp updater.", "The process could not be started.")
    })?;
    let new_version = probe_ytdlp_version(&exe).unwrap_or_else(|| "unknown".to_string());
    Ok(format!("{out}\nUpdated to: {new_version}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_comparison() {
        assert!(version_newer("2025.02.01", "2025.01.26"));
        assert!(version_newer("2026.01.01", "2025.12.31"));
        assert!(!version_newer("2025.01.26", "2025.01.26"));
        assert!(!version_newer("2025.01.01", "2025.02.01"));
    }
}
