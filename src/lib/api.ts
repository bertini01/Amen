import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import type {
   AnalyzeResult,
   MusicLink,
   TidyReport,
   AppInfo,
   AppSettings,
   DependencyReport,
   DownloadFailedEvent,
   DownloadRequest,
   HistoryItem,
   InstallProgressEvent,
   Job,
   SystemUsage,
   YtdlpUpdateInfo,
} from "./types";

// ---- typed wrappers around Tauri commands --------------------------------

export const api = {
   getAppInfo: () => invoke<AppInfo>("get_app_info"),
   getLogsDir: () => invoke<string>("get_logs_dir"),
   getDiagnosticText: () => invoke<string>("get_diagnostic_text"),
   getSystemUsage: () => invoke<SystemUsage>("system_usage"),

   getSettings: () => invoke<AppSettings>("get_settings"),
   saveSettings: (settings: AppSettings) =>
      invoke<AppSettings>("save_settings", { settings }),
   selectDirectory: (initial?: string) =>
      invoke<string | null>("select_directory", { initial: initial ?? null }),
   validateOutputDir: (path: string) =>
      invoke<void>("validate_output_dir", { path }),

   analyzeUrl: (url: string) => invoke<AnalyzeResult>("analyze_url", { url }),
   resolveMusicLink: (url: string) =>
      invoke<MusicLink>("resolve_music_link", { url }),

   startDownload: (request: DownloadRequest) =>
      invoke<Job>("start_download", { request }),
   cancelDownload: (id: string) => invoke<void>("cancel_download", { id }),
   retryDownload: (id: string) => invoke<void>("retry_download", { id }),
   removeJob: (id: string) => invoke<void>("remove_job", { id }),
   clearCompletedJobs: () => invoke<void>("clear_completed_jobs"),
   listJobs: () => invoke<Job[]>("list_jobs"),

   getHistory: (opts: {
      query?: string;
      formatFilter?: string;
      statusFilter?: string;
      sort?: string;
   }) =>
      invoke<HistoryItem[]>("get_history", {
         query: opts.query ?? null,
         formatFilter: opts.formatFilter ?? null,
         statusFilter: opts.statusFilter ?? null,
         sort: opts.sort ?? "date",
      }),
   removeHistoryItem: (id: string) =>
      invoke<void>("remove_history_item", { id }),
   clearHistory: () => invoke<void>("clear_history"),
   /** With preview, only counts; otherwise moves the files and updates History. */
   tidyDownloadFolders: (preview: boolean) =>
      invoke<TidyReport>("tidy_download_folders", { preview }),

   openFile: (path: string) => invoke<void>("open_file", { path }),
   openFolder: (path: string) => invoke<void>("open_folder", { path }),
   revealInFolder: (path: string) => invoke<void>("reveal_in_folder", { path }),

   detectDependencies: () => invoke<DependencyReport>("detect_dependencies"),
   installDependencies: (what: "all" | "yt-dlp" | "ffmpeg") =>
      invoke<DependencyReport>("install_dependencies", { what }),
   checkYtdlpUpdate: () => invoke<YtdlpUpdateInfo>("check_ytdlp_update"),
   updateYtdlp: () => invoke<string>("update_ytdlp"),
};

// ---- Audio Studio commands -------------------------------------------------

import type {
   AudioInfo,
   RenderResult,
   StudioProject,
   StudioSource,
   WaveformData,
} from "./studioTypes";
import { convertFileSrc } from "@tauri-apps/api/core";

export const studioApi = {
   /** Probe an audio file, returning duration/codec/bitrate etc. */
   probeAudio: (path: string) =>
      invoke<AudioInfo>("studio_probe_audio", { path }),

   /** Extract a peak waveform for the given file. */
   waveform: (path: string, bucketsPerSecond?: number) =>
      invoke<WaveformData>("studio_waveform", {
         path,
         bucketsPerSecond: bucketsPerSecond ?? 10,
      }),

   /** Render (and cache) a preview mix. Returns a path suitable for playback. */
   renderPreview: (project: StudioProject) =>
      invoke<RenderResult>("studio_render_preview", { project }),

   /** Export the full mix to a file. */
   exportMix: (
      project: StudioProject,
      outputPath: string,
      format: string,
      bitrateKbps: number,
   ) =>
      invoke<RenderResult>("studio_export_mix", {
         project,
         outputPath,
         format,
         bitrateKbps,
      }),

   /** Export a single clip (source section) to a file. */
   exportClip: (
      sourcePath: string,
      start: number,
      end: number,
      outputPath: string,
      format: string,
      bitrateKbps: number,
   ) =>
      invoke<RenderResult>("studio_export_clip", {
         sourcePath,
         start,
         end,
         outputPath,
         format,
         bitrateKbps,
      }),

   /** Save a project as .lms (JSON). */
   saveProject: (project: StudioProject, path: string) =>
      invoke<void>("studio_save_project", { project, path }),

   /** Load a project from .lms. */
   loadProject: (path: string) =>
      invoke<StudioProject>("studio_load_project", { path }),

   /** List sources referenced by the project that no longer exist. */
   missingSources: (project: StudioProject) =>
      invoke<StudioSource[]>("studio_missing_sources", { project }),

   /** True if the given path exists on disk. */
   pathExists: (path: string) =>
      invoke<boolean>("studio_path_exists", { path }),
};

/** Convert a local file path into a src= URL for `<audio>` playback. */
export function assetUrl(path: string): string {
   return convertFileSrc(path);
}

// ---- clipboard (with web fallback) ----------------------------------------

export const clipboard = {
   readText: async (): Promise<string> => {
      try {
         return await readText();
      } catch {
         try {
            return await navigator.clipboard.readText();
         } catch {
            return "";
         }
      }
   },
   writeText: async (text: string): Promise<void> => {
      try {
         await writeText(text);
      } catch {
         try {
            await navigator.clipboard.writeText(text);
         } catch {
            // Callers toast "Copied" on success, so a silent failure lied.
            throw new Error("Couldn't copy to the clipboard.");
         }
      }
   },
};

// ---- event subscriptions -------------------------------------------------

export type EventMap = {
   "download-updated": Job;
   "download-finished": Job;
   "download-failed": DownloadFailedEvent;
   "install-progress": InstallProgressEvent;
};

export function onEvent<K extends keyof EventMap>(
   event: K,
   handler: (payload: EventMap[K]) => void,
): Promise<UnlistenFn> {
   return listen<EventMap[K]>(event, (e) => handler(e.payload));
}
