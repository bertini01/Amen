import { useEffect } from "react";
import { Sidebar } from "@/components/Sidebar";
import { Toaster } from "@/components/ui/toast";
import { UiDialogHost } from "@/components/UiDialogHost";
import { TooltipProvider } from "@/components/ui/tooltip";
import { HomeView } from "@/views/HomeView";
import { DownloadsView } from "@/views/DownloadsView";
import { HistoryView } from "@/views/HistoryView";
import { SettingsView } from "@/views/SettingsView";
import { DiagnosticsView } from "@/views/DiagnosticsView";
import { StudioView } from "@/views/StudioView";
import { useAppStore } from "@/stores/app";
import { useQueueStore, initQueueEvents } from "@/stores/queue";
import { useSettingsStore } from "@/stores/settings";
import { clipboard, onEvent } from "@/lib/api";
import { normalizeUrl, isHttpUrl } from "@/lib/url";
import { toast } from "@/stores/toast";

const VIEWS = {
   home: HomeView,
   downloads: DownloadsView,
   history: HistoryView,
   settings: SettingsView,
   diagnostics: DiagnosticsView,
   studio: StudioView,
} as const;

export default function App() {
   const view = useAppStore((s) => s.view);
   const analyze = useAppStore((s) => s.analyze);

   useEffect(() => {
      // Bootstrap: app info, settings, queue, history, deps
      useAppStore.getState().loadAppInfo();
      useSettingsStore.getState().load();
      initQueueEvents();
      useQueueStore.getState().refresh();
      useAppStore.getState().refreshDeps();
      useAppStore.getState().checkForYtdlpUpdateOncePerDay();

      // Dependency-install progress is tracked app-wide (not inside
      // Diagnostics), so leaving that view mid-install and coming back still
      // shows live progress instead of a re-enabled Install button.
      const unlistenInstall = onEvent("install-progress", (p) =>
         useAppStore.getState().setInstallProgress(p),
      );

      // Clipboard monitoring (opt-in via Settings → Advanced).
      // Deliberately a low-frequency poll only while the setting is on.
      let intervalId: ReturnType<typeof setInterval> | undefined;
      let lastClipboard = "";

      const startClipboardWatch = () => {
         if (intervalId) return;
         intervalId = setInterval(async () => {
            const settings = useSettingsStore.getState().settings;
            if (!settings?.clipboardMonitor) return;
            if (useAppStore.getState().view !== "home") return;
            const text = (await clipboard.readText()).trim();
            if (!text || text === lastClipboard) return;
            lastClipboard = text;
            if (isHttpUrl(text)) {
               const store = useAppStore.getState();
               if (!store.analyzing && !store.media && !store.playlist) {
                  toast("URL detected in clipboard", "Analyzing…", "info");
                  analyze(normalizeUrl(text));
               }
            }
         }, 2500);
      };

      const stopClipboardWatch = () => {
         if (intervalId) {
            clearInterval(intervalId);
            intervalId = undefined;
         }
      };

      const sub = useSettingsStore.subscribe((state, prev) => {
         const now = state.settings?.clipboardMonitor;
         const was = prev.settings?.clipboardMonitor;
         if (now && !was) startClipboardWatch();
         else if (!now && was) stopClipboardWatch();
      });

      if (useSettingsStore.getState().settings?.clipboardMonitor)
         startClipboardWatch();

      return () => {
         stopClipboardWatch();
         sub();
         unlistenInstall.then((fn) => fn()).catch(() => undefined);
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
   }, []);

   const Current = VIEWS[view];

   return (
      <TooltipProvider delayDuration={200}>
         <div className="flex h-full overflow-hidden bg-background text-foreground">
            <Sidebar />
            <main className="flex-1 overflow-y-auto">
               <Current />
            </main>
            <Toaster />
            {/* In-app confirm/alert/prompt — one host for every view */}
            <UiDialogHost />
         </div>
      </TooltipProvider>
   );
}
