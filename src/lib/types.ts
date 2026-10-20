// Shared types mirroring the Rust backend (serde camelCase).

export type View =
   | "home"
   | "downloads"
   | "history"
   | "settings"
   | "diagnostics"
   | "studio";

export type MediaFormat = "mp3" | "mp4";

export type JobStatus =
   | "pending"
   | "fetching"
   | "downloading"
   | "processing"
   | "completed"
   | "failed"
   | "cancelled"
   | "skipped"
   | "interrupted";

export interface AppInfo {
   appName: string;
   version: string;
   dataDir: string;
   toolsDir: string;
   logsDir: string;
   defaultOutputDir: string;
   platform: string;
   arch: string;
   /** Set when running as the Microsoft Store (MSIX) package. */
   packageFamilyName: string | null;
}

export interface AppSettings {
   theme: "dark" | "light" | "system";
   startupBehavior: "restore" | "empty";
   defaultFormat: MediaFormat;
   defaultQuality: QualityOption;
   outputDir: string;
   filenameTemplate: string;
   overwriteBehavior: "skip" | "replace" | "new_copy";
   duplicateHandling: "skip" | "replace" | "new_copy";
   embedArtwork: boolean;
   embedMetadata: boolean;
   ytdlpPath: string;
   ffmpegPath: string;
   ffprobePath: string;
   maxConcurrent: number;
   clipboardMonitor: boolean;
   notifyOnComplete: boolean;
   cookiesFile: string;
}

export type QualityOption = "best" | "320" | "256" | "192" | "128";

export interface ToolInfo {
   name: string;
   found: boolean;
   version: string | null;
   path: string | null;
   source: string;
}

export interface DirCheck {
   ok: boolean;
   path: string;
   error: string | null;
}

export interface DiskCheck {
   ok: boolean;
   path: string;
   freeBytes: number;
   requiredBytes: number;
   error: string | null;
}

export interface NetworkCheck {
   ok: boolean;
   error: string | null;
   latencyMs: number | null;
   host: string | null;
}

export interface DependencyReport {
   ytdlp: ToolInfo;
   ffmpeg: ToolInfo;
   ffprobe: ToolInfo;
   outputDir: DirCheck;
   diskSpace: DiskCheck;
   network: NetworkCheck;
   toolsDir: string;
   python: string | null;
}

export interface FormatInfo {
   formatId: string | null;
   ext: string | null;
   vcodec: string | null;
   acodec: string | null;
   abr: number | null;
   tbr: number | null;
   filesize: number | null;
   formatNote: string | null;
   height: number | null;
   width: number | null;
}

export interface MediaInfo {
   id: string | null;
   title: string | null;
   uploader: string | null;
   channel: string | null;
   duration: number | null;
   viewCount: number | null;
   uploadDate: string | null;
   thumbnail: string | null;
   webpageUrl: string | null;
   originalUrl: string | null;
   extractor: string | null;
   extractorKey: string | null;
   description: string | null;
   album: string | null;
   artist: string | null;
   track: string | null;
   releaseDate: string | null;
   genre: string | null;
   trackNumber: number | null;
   availability: string | null;
   ageLimit: number | null;
   playlistIndex: number | null;
   bestAudioBitrate: number | null;
   bestAudioFormat: string | null;
   formats: FormatInfo[];
}

export interface PlaylistInfo {
   id: string | null;
   title: string | null;
   uploader: string | null;
   webpageUrl: string | null;
   extractor: string | null;
   extractorKey: string | null;
   count: number | null;
   entries: MediaInfo[];
}

export type AnalyzeResult =
   | { Media: MediaInfo }
   | { Playlist: PlaylistInfo }
   | "Unsupported";

export interface Job {
   id: string;
   url: string;
   title: string | null;
   thumbnail: string | null;
   mediaId: string | null;
   uploader: string | null;
   channel: string | null;
   artist: string | null;
   album: string | null;
   track: string | null;
   playlistTitle: string | null;
   uploadDate: string | null;
   releaseDate: string | null;
   genre: string | null;
   trackNumber: number | null;
   playlistIndex: number | null;
   format: MediaFormat;
   quality: QualityOption;
   status: JobStatus;
   progress: number;
   speed: string | null;
   eta: string | null;
   downloaded: number | null;
   total: number | null;
   stage: string | null;
   error: string | null;
   outputPath: string | null;
   fileSize: number | null;
   duration: number | null;
   createdAt: number;
   completedAt: number | null;
   extractor: string | null;
}

export interface DownloadRequest {
   url: string;
   format: MediaFormat;
   quality: QualityOption;
   title?: string | null;
   thumbnail?: string | null;
   mediaId?: string | null;
   uploader?: string | null;
   channel?: string | null;
   artist?: string | null;
   album?: string | null;
   track?: string | null;
   playlistTitle?: string | null;
   uploadDate?: string | null;
   releaseDate?: string | null;
   genre?: string | null;
   trackNumber?: number | null;
   playlistIndex?: number | null;
   duration?: number | null;
   extractor?: string | null;
   /** Skip duplicate detection (History's "Download again"); never ends as "Skipped". */
   force?: boolean;
}

export interface HistoryItem {
   id: string;
   title: string | null;
   url: string;
   mediaId: string | null;
   extractor: string | null;
   thumbnail: string | null;
   format: MediaFormat;
   quality: QualityOption;
   filePath: string;
   fileSize: number | null;
   duration: number | null;
   status: JobStatus;
   createdAt: number;
}

export interface InstallProgressEvent {
   stage: string;
   percent: number | null;
   message: string;
}

export interface DownloadFailedEvent {
   job: Job;
   error: { message: string; code: string; detail: string | null };
   detail: string;
}

export interface YtdlpUpdateInfo {
   current: string;
   latest: string;
   updateAvailable: boolean;
   bundled: string;
}

export interface AppError {
   message: string;
   code: string;
   detail: string | null;
}

/** Real local system telemetry (via `sysinfo`) — nothing simulated. */
export interface SystemUsage {
   processCpuPercent: number;
   processMemMb: number;
   systemMemUsedMb: number;
   systemMemTotalMb: number;
}

/** A song as described by a copy-protected streaming service (see music_link.rs). */
export interface MusicTrack {
   title: string;
   artists: string;
   /** Seconds. */
   duration: number | null;
   /** What to search for to find this song on a site that allows saving. */
   query: string;
}

/** The public description of a Spotify song, album or playlist link. */
export interface MusicLink {
   service: string;
   kind: "track" | "album" | "playlist";
   title: string;
   subtitle: string | null;
   cover: string | null;
   url: string;
   tracks: MusicTrack[];
}

/** Result of moving downloads out of accidental sub-folders. */
export interface TidyReport {
   found: number;
   moved: number;
   failed: string[];
   removedFolders: number;
}
