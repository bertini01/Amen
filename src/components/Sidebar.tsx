import {
   Download,
   History,
   Home,
   Settings,
   Stethoscope,
   Music,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/stores/app";
import { useQueueStore } from "@/stores/queue";
import { useSettingsStore } from "@/stores/settings";
import { appConfirm } from "@/stores/uiDialog";
import type { View } from "@/lib/types";
import { ACTIVE_STATUSES } from "@/lib/constants";

const NAV: { view: View; label: string; icon: typeof Home }[] = [
   { view: "home", label: "Home", icon: Home },
   { view: "downloads", label: "Downloads", icon: Download },
   { view: "history", label: "History", icon: History },
   { view: "studio", label: "Audio Studio", icon: Music },
   { view: "settings", label: "Settings", icon: Settings },
   { view: "diagnostics", label: "Diagnostics", icon: Stethoscope },
];

export function Sidebar() {
   const view = useAppStore((s) => s.view);
   const setView = useAppStore((s) => s.setView);
   const navigate = async (next: View) => {
      if (next === view) return;
      // Leaving Settings throws its unsaved draft away, so ask first.
      if (view === "settings" && useSettingsStore.getState().dirty) {
         const discard = await appConfirm(
            "You have unsaved settings changes. Leave without saving them?",
            {
               title: "Discard changes?",
               confirmLabel: "Discard",
               cancelLabel: "Keep editing",
               destructive: true,
            },
         );
         if (!discard) return;
      }
      setView(next);
   };
   const activeCount = useQueueStore(
      (s) => s.jobs.filter((j) => ACTIVE_STATUSES.includes(j.status)).length,
   );

   return (
      <aside className="flex w-56 shrink-0 flex-col border-r border-border bg-sidebar">
         {/* Brand */}
         <div className="flex items-center gap-2.5 px-4 pb-4 pt-5">
            <img
               src="/logo.png"
               alt="Amen Studio"
               className="h-8 w-8 rounded-lg object-contain shadow-md shadow-blue-500/20"
            />
            <div className="leading-tight">
               <div className="text-[13px] font-semibold tracking-tight text-foreground">
                  Amen <span className="text-primary">Studio</span>
               </div>
               <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                  Listen · Capture · Create
               </div>
            </div>
         </div>

         {/* Nav */}
         <nav className="flex-1 space-y-0.5 px-2">
            {NAV.map(({ view: v, label, icon: Icon }) => {
               const active = view === v;
               return (
                  <button
                     key={v}
                     onClick={() => navigate(v)}
                     className={cn(
                        "group flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] font-medium transition-colors",
                        active
                           ? "bg-accent text-accent-foreground shadow-sm"
                           : "text-sidebar-foreground hover:bg-accent/60 hover:text-foreground",
                     )}
                  >
                     <Icon
                        className={cn(
                           "h-4 w-4",
                           active
                              ? "text-primary"
                              : "text-muted-foreground group-hover:text-foreground",
                        )}
                        strokeWidth={2}
                     />
                     <span className="flex-1 text-left">{label}</span>
                     {v === "downloads" && activeCount > 0 && (
                        <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-primary/15 px-1.5 text-[11px] font-semibold text-primary">
                           {activeCount}
                        </span>
                     )}
                  </button>
               );
            })}
         </nav>

         {/* Footer */}
         <div className="border-t border-border/70 px-4 py-3">
            <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
               <span className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-60" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-success" />
               </span>
               Local · Private · Offline
            </div>
         </div>
      </aside>
   );
}
