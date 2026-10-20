import { create } from "zustand";
import { api } from "@/lib/api";
import { isSpotifyLink } from "@/lib/url";
import { rankMatches, type RankedMatch } from "@/lib/musicMatch";
import type {
   AnalyzeResult,
   AppError,
   AppInfo,
   DependencyReport,
   InstallProgressEvent,
   MediaInfo,
   MusicLink,
   PlaylistInfo,
   View,
} from "@/lib/types";

interface AppState {
   view: View;
   appInfo: AppInfo | null;
   deps: DependencyReport | null;

   analyzing: boolean;
   analysisError: AppError | null;
   media: MediaInfo | null;
   playlist: PlaylistInfo | null;
   pendingUrl: string | null;

   /** A Spotify link: the songs it describes, and matches for the chosen one. */
   musicLink: MusicLink | null;
   musicTrackIndex: number | null;
   musicMatches: RankedMatch[] | null;
   musicSearching: boolean;
   musicError: AppError | null;

   installing: boolean;
   installProgress: InstallProgressEvent | null;

   setView: (v: View) => void;
   loadAppInfo: () => Promise<void>;
   refreshDeps: () => Promise<void>;
   checkForYtdlpUpdateOncePerDay: () => Promise<void>;
   analyze: (url: string) => Promise<void>;
   clearAnalysis: () => void;
   findMusicTrack: (index: number) => Promise<void>;
   setInstalling: (v: boolean) => void;
   setInstallProgress: (p: InstallProgressEvent | null) => void;
}

const NO_MUSIC = {
   musicLink: null,
   musicTrackIndex: null,
   musicMatches: null,
   musicSearching: false,
   musicError: null,
};

export const useAppStore = create<AppState>((set, get) => ({
   view: "home",
   appInfo: null,
   deps: null,
   analyzing: false,
   analysisError: null,
   media: null,
   playlist: null,
   pendingUrl: null,
   musicLink: null,
   musicTrackIndex: null,
   musicMatches: null,
   musicSearching: false,
   musicError: null,
   installing: false,
   installProgress: null,

   setView: (view) => set({ view }),

   loadAppInfo: async () => {
      try {
         const appInfo = await api.getAppInfo();
         set({ appInfo });
      } catch {
         /* non-fatal */
      }
   },

   refreshDeps: async () => {
      try {
         const deps = await api.detectDependencies();
         set({ deps });
      } catch {
         /* non-fatal */
      }
   },

   checkForYtdlpUpdateOncePerDay: async () => {
      // Throttled, silent, background-only nudge: yt-dlp is not shipped in the
      // installer (it's fetched from GitHub's "latest" at install time — see
      // Diagnostics), so an install can quietly go stale over weeks as
      // YouTube's extraction arms race moves on, with nothing prompting the
      // user back into Diagnostics to click "Check for updates" themselves.
      // Never auto-installs — that would risk reproducibility/stability; this
      // only surfaces a toast so the user can make the call.
      try {
         const key = "amen:lastYtdlpUpdateCheck";
         const last = Number(localStorage.getItem(key) || 0);
         if (Date.now() - last < 24 * 60 * 60 * 1000) return;
         localStorage.setItem(key, String(Date.now()));
         const info = await api.checkYtdlpUpdate();
         if (info.updateAvailable) {
            const { toast } = await import("@/stores/toast");
            toast(
               "yt-dlp update available",
               `A newer version (${info.latest}) is available — you have ${info.current}. Update it in Diagnostics to keep downloads working reliably.`,
               "info",
            );
         }
      } catch {
         /* offline or not installed yet — non-fatal, silent */
      }
   },

   analyze: async (url) => {
      set({ analyzing: true, analysisError: null, ...NO_MUSIC });
      if (isSpotifyLink(url)) {
         // Spotify audio is copy-protected; describe the songs instead and let
         // the user pick a version they can save (see music_link.rs).
         try {
            const musicLink = await api.resolveMusicLink(url);
            set({ analyzing: false, musicLink, media: null, playlist: null, pendingUrl: url });
            if (musicLink.kind === "track") await get().findMusicTrack(0);
         } catch (e) {
            set({ analyzing: false, analysisError: e as AppError, media: null, playlist: null, pendingUrl: url });
         }
         return;
      }
      try {
         const result: AnalyzeResult = await api.analyzeUrl(url);
         if (result === "Unsupported") {
            set({
               analyzing: false,
               analysisError: {
                  message: "This URL is not supported by yt-dlp.",
                  code: "unsupported_url",
                  detail: null,
               },
               media: null,
               playlist: null,
               pendingUrl: url,
            });
            return;
         }
         if ("Media" in result) {
            set({
               analyzing: false,
               media: result.Media,
               playlist: null,
               pendingUrl: url,
            });
         } else if ("Playlist" in result) {
            set({
               analyzing: false,
               playlist: result.Playlist,
               media: null,
               pendingUrl: url,
            });
         }
      } catch (e) {
         const err = e as AppError;
         set({
            analyzing: false,
            analysisError: err,
            media: null,
            playlist: null,
            pendingUrl: url,
         });
         if (err.code === "dependency_missing") {
            set({ view: "diagnostics" });
         }
      }
   },

   clearAnalysis: () =>
      set({
         media: null,
         playlist: null,
         analysisError: null,
         pendingUrl: null,
         ...NO_MUSIC,
      }),

   findMusicTrack: async (index) => {
      const track = get().musicLink?.tracks[index];
      if (!track) return;
      set({ musicTrackIndex: index, musicMatches: null, musicSearching: true, musicError: null });
      try {
         const result = await api.analyzeUrl(track.query);
         // Ignore a reply for a song the user has since moved away from.
         if (get().musicTrackIndex !== index) return;
         const entries =
            result !== "Unsupported" && "Playlist" in result
               ? result.Playlist.entries
               : result !== "Unsupported" && "Media" in result
                 ? [result.Media]
                 : [];
         set({ musicMatches: rankMatches(track, entries), musicSearching: false });
      } catch (e) {
         if (get().musicTrackIndex !== index) return;
         set({ musicSearching: false, musicError: e as AppError });
      }
   },

   setInstalling: (installing) => set({ installing }),
   setInstallProgress: (installProgress) => set({ installProgress }),
}));
