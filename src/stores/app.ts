import { create } from "zustand";
import { api } from "@/lib/api";
import type {
   AnalyzeResult,
   AppError,
   AppInfo,
   DependencyReport,
   InstallProgressEvent,
   MediaInfo,
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

   installing: boolean;
   installProgress: InstallProgressEvent | null;

   setView: (v: View) => void;
   loadAppInfo: () => Promise<void>;
   refreshDeps: () => Promise<void>;
   checkForYtdlpUpdateOncePerDay: () => Promise<void>;
   analyze: (url: string) => Promise<void>;
   clearAnalysis: () => void;
   setInstalling: (v: boolean) => void;
   setInstallProgress: (p: InstallProgressEvent | null) => void;
}

export const useAppStore = create<AppState>((set) => ({
   view: "home",
   appInfo: null,
   deps: null,
   analyzing: false,
   analysisError: null,
   media: null,
   playlist: null,
   pendingUrl: null,
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
      set({ analyzing: true, analysisError: null });
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
      }),

   setInstalling: (installing) => set({ installing }),
   setInstallProgress: (installProgress) => set({ installProgress }),
}));
