pub mod analyze;
pub mod deps;
pub mod fs;
pub mod history;
pub mod jobs;
pub mod settings;
pub mod studio;
pub mod system;

use crate::config;
use crate::download::DownloadManager;
use crate::error::AppError;
use crate::logger;
use serde::Serialize;
use std::sync::Arc;
use tauri::State;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub app_name: String,
    pub version: String,
    pub data_dir: String,
    pub tools_dir: String,
    pub logs_dir: String,
    pub default_output_dir: String,
    pub platform: String,
    pub arch: String,
    /// MSIX package family name when running as the Store build. The
    /// directories above are then the real on-disk locations (under
    /// %LOCALAPPDATA%\Packages\<family>\LocalCache), as Explorer sees them.
    pub package_family_name: Option<String>,
}

#[tauri::command]
pub fn get_app_info() -> AppInfo {
    AppInfo {
        app_name: config::APP_NAME.to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        data_dir: real_dir(config::app_data_dir()),
        tools_dir: real_dir(config::tools_dir()),
        logs_dir: real_dir(config::logs_dir()),
        default_output_dir: config::default_output_dir().to_string_lossy().to_string(),
        platform: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        package_family_name: config::package_family_name(),
    }
}

#[tauri::command]
pub fn get_logs_dir() -> String {
    real_dir(config::logs_dir())
}

#[tauri::command]
pub async fn get_diagnostic_text(
    state: State<'_, Arc<DownloadManager>>,
) -> Result<String, AppError> {
    let jobs = state.list_jobs();
    tauri::async_runtime::spawn_blocking(move || {
        let settings = config::AppSettings::load();
        let report = crate::tools::detect_dependencies(&settings);
        let mut out = String::new();
        out.push_str("Amen — Diagnostic Report\n");
        out.push_str("========================================\n");
        out.push_str(&format!(
            "App version: {}\nPlatform: {} ({})\n",
            env!("CARGO_PKG_VERSION"),
            std::env::consts::OS,
            std::env::consts::ARCH
        ));
        if let Some(pfn) = config::package_family_name() {
            out.push_str(&format!("Package: {pfn} (MSIX)\n"));
        }
        out.push_str(&format!("Data dir: {}\n", real_dir(config::app_data_dir())));
        out.push_str(&format!("Tools dir: {}\n", real_dir(config::tools_dir())));
        out.push_str(&format!("Logs dir: {}\n", real_dir(config::logs_dir())));
        out.push_str(&format!(
            "Output dir: {} ({})\n",
            report.output_dir.path,
            if report.output_dir.ok {
                "writable"
            } else {
                "NOT WRITABLE"
            }
        ));
        out.push_str("\n--- Dependencies ---\n");
        for tool in [&report.ytdlp, &report.ffmpeg, &report.ffprobe] {
            out.push_str(&format!(
                "{}: {} (source: {}, version: {})\n",
                tool.name,
                if tool.found { "installed" } else { "MISSING" },
                tool.source,
                tool.version.as_deref().unwrap_or("n/a")
            ));
        }
        out.push_str(&format!(
            "Network: {} ({} ms via {})\n",
            if report.network.ok {
                "reachable"
            } else {
                "UNREACHABLE"
            },
            report
                .network
                .latency_ms
                .map(|m| m.to_string())
                .unwrap_or_else(|| "n/a".to_string()),
            report.network.host.as_deref().unwrap_or("n/a")
        ));
        out.push_str("\n--- Active jobs ---\n");
        for job in &jobs {
            out.push_str(&format!(
                "[{}] {} — {} (progress {:.0}%)\n",
                job.status,
                job.title.as_deref().unwrap_or("untitled"),
                job.format,
                job.progress
            ));
        }
        out.push_str("\n--- Settings (cookies path omitted) ---\n");
        // Never include the cookies file path in diagnostics
        let mut settings_redacted = settings.clone();
        settings_redacted.cookies_file = "[redacted]".to_string();
        let settings_json = serde_json::to_string_pretty(&settings_redacted).unwrap_or_default();
        out.push_str(&settings_json);
        out.push_str("\n\n--- Recent logs ---\n");
        out.push_str(&logger::tail(150));
        out
    })
    .await
    .map_err(|e| AppError::with_detail("diagnostics_failed", "Could not generate diagnostics.", e.to_string()))
}

/// A data directory as the user and Explorer find it on disk (see
/// `config::shell_visible_path`; unchanged outside the MSIX package).
fn real_dir(dir: std::path::PathBuf) -> String {
    config::shell_visible_path(&dir).to_string_lossy().to_string()
}
