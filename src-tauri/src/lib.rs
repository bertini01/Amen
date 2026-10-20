mod analyze;
mod arggen;
mod audio;
mod commands;
mod config;
mod download;
mod error;
mod history;
mod logger;
mod music_link;
mod process;
mod progress;
mod tools;
mod util;

#[cfg(test)]
mod integration_tests;

use download::DownloadManager;
use std::sync::Arc;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_notification::init())
        .manage(DownloadManager::new())
        .manage(commands::system::SystemMonitor::new())
        .setup(|app| {
            let mgr = app.state::<Arc<DownloadManager>>();
            mgr.set_app(app.handle().clone());
            mgr.restore_persisted_jobs();
            let _ = std::fs::create_dir_all(config::logs_dir());
            // Studio previews used to be cached in Roaming AppData; that
            // cache is now local, so drop the old copy from the profile.
            if config::legacy_cache_dir() != config::cache_dir() {
                std::thread::spawn(|| {
                    let _ = std::fs::remove_dir_all(config::legacy_cache_dir());
                });
            }
            logger::info("startup", "Application started");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_app_info,
            commands::get_logs_dir,
            commands::get_diagnostic_text,
            commands::settings::get_settings,
            commands::settings::save_settings,
            commands::settings::select_directory,
            commands::jobs::validate_output_dir,
            commands::analyze::analyze_url,
            commands::analyze::resolve_music_link,
            commands::jobs::start_download,
            commands::jobs::cancel_download,
            commands::jobs::retry_download,
            commands::jobs::remove_job,
            commands::jobs::clear_completed_jobs,
            commands::jobs::list_jobs,
            commands::history::get_history,
            commands::history::remove_history_item,
            commands::history::clear_history,
            commands::history::tidy_download_folders,
            commands::fs::open_file,
            commands::fs::open_folder,
            commands::fs::reveal_in_folder,
            commands::deps::detect_dependencies,
            commands::deps::install_dependencies,
            commands::deps::check_ytdlp_update,
            commands::deps::update_ytdlp,
            commands::studio::studio_probe_audio,
            commands::studio::studio_waveform,
            commands::studio::studio_render_preview,
            commands::studio::studio_export_mix,
            commands::studio::studio_export_clip,
            commands::studio::studio_save_project,
            commands::studio::studio_load_project,
            commands::studio::studio_missing_sources,
            commands::studio::studio_path_exists,
            commands::system::system_usage,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                let mgr = app_handle.state::<Arc<DownloadManager>>();
                mgr.shutdown();
                logger::info("shutdown", "Application shutting down; child processes terminated");
            }
        });
}
