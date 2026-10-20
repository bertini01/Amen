import { create } from "zustand";
import { api } from "@/lib/api";
import type { AppSettings } from "@/lib/types";

interface SettingsState {
   /**
    * The settings as last SAVED (or loaded). Unsaved edits live in the
    * Settings view's own draft and never land here — they used to, which
    * leaked half-typed values into the rest of the app and let unrelated
    * saves (a theme change, Home's "Browse destination") persist them.
    */
   settings: AppSettings | null;
   loaded: boolean;
   /** True while the Settings view holds edits that haven't been saved. */
   dirty: boolean;
   load: () => Promise<void>;
   /** Merge `patch` onto the last-saved settings and persist the result. */
   save: (patch: Partial<AppSettings>) => Promise<AppSettings>;
   /** Apply a theme immediately and persist ONLY the theme. Reverts and rethrows on failure. */
   setTheme: (theme: AppSettings["theme"]) => Promise<void>;
   setDirty: (dirty: boolean) => void;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
   settings: null,
   loaded: false,
   dirty: false,

   load: async () => {
      try {
         const settings = await api.getSettings();
         applyTheme(settings.theme);
         set({ settings, loaded: true });
      } catch {
         /* non-fatal */
      }
   },

   save: async (patch) => {
      // Settings not loaded yet: fetch them first, then apply the patch.
      // (This used to return the fresh copy and silently drop the patch.)
      const current = get().settings ?? (await api.getSettings());
      const merged: AppSettings = { ...current, ...patch };
      const saved = await api.saveSettings(merged);
      applyTheme(saved.theme);
      set({ settings: saved, loaded: true });
      return saved;
   },

   setTheme: async (theme) => {
      const previous = get().settings?.theme;
      applyTheme(theme);
      try {
         await get().save({ theme });
      } catch (e) {
         if (previous) applyTheme(previous);
         throw e;
      }
   },

   setDirty: (dirty) => set({ dirty }),
}));

/**
 * The subset of `edits` that actually differs from `saved`. An edit typed
 * back to its saved value drops out, so the view can tell "touched" from
 * "changed" and the unsaved-changes state stays honest.
 */
export function diffSettings(
   saved: AppSettings,
   edits: Partial<AppSettings>,
): Partial<AppSettings> {
   const out: Partial<AppSettings> = {};
   for (const key of Object.keys(edits) as (keyof AppSettings)[]) {
      const value = edits[key];
      if (value === undefined || value === saved[key]) continue;
      (out as Record<string, unknown>)[key] = value;
   }
   return out;
}

function applyTheme(theme: AppSettings["theme"]) {
   const root = document.documentElement;
   if (theme === "system") {
      const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
      root.classList.toggle("dark", dark);
   } else {
      root.classList.toggle("dark", theme === "dark");
   }
}
