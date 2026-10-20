import { create } from "zustand";

// Native window.confirm/alert/prompt do not reliably surface in the Tauri
// WebView2 host used by this app: confirm() resolves to a truthy stub with
// no visible UI (every "Are you sure?" silently proceeds — including
// discard-unsaved-changes and delete confirmations, a real data-loss risk),
// and prompt() always returns null (rename is a dead button). This store
// backs real in-app modal replacements instead. The host is mounted once at
// the app root, so every view can use these — not just the Studio.

export interface ConfirmOptions {
   title?: string;
   /** Label of the affirmative button (default "OK"). */
   confirmLabel?: string;
   cancelLabel?: string;
   /** Style the affirmative button as a destructive action. */
   destructive?: boolean;
}

export interface DialogChoice {
   id: string;
   label: string;
   /** The primary choice gets the accent style and initial focus. */
   primary?: boolean;
}

export type DialogRequest =
   | ({ kind: "confirm"; message: string; resolve: (v: boolean) => void } & ConfirmOptions)
   | { kind: "alert"; message: string; title?: string; resolve: (v: void) => void }
   | { kind: "prompt"; message: string; defaultValue: string; resolve: (v: string | null) => void }
   | {
        kind: "choice";
        message: string;
        title?: string;
        choices: DialogChoice[];
        cancelLabel: string;
        resolve: (v: string | null) => void;
     };

/** Settle a request as if the user dismissed it (Cancel / Escape). */
export function dismissRequest(req: DialogRequest) {
   switch (req.kind) {
      case "confirm":
         req.resolve(false);
         break;
      case "alert":
         req.resolve();
         break;
      case "prompt":
      case "choice":
         req.resolve(null);
         break;
   }
}

interface UiDialogStore {
   request: DialogRequest | null;
   show: (req: DialogRequest) => void;
   clear: () => void;
}

export const useUiDialogStore = create<UiDialogStore>((set, get) => ({
   request: null,
   show: (req) => {
      // Only one modal is visible at a time. A request that gets replaced
      // must still settle, or whoever awaited it hangs forever.
      const prev = get().request;
      if (prev) dismissRequest(prev);
      set({ request: req });
   },
   clear: () => set({ request: null }),
}));

export function appConfirm(message: string, options: ConfirmOptions = {}): Promise<boolean> {
   return new Promise((resolve) => {
      useUiDialogStore.getState().show({ kind: "confirm", message, resolve, ...options });
   });
}

export function appAlert(message: string, title?: string): Promise<void> {
   return new Promise((resolve) => {
      useUiDialogStore.getState().show({ kind: "alert", message, title, resolve });
   });
}

export function appPrompt(message: string, defaultValue = ""): Promise<string | null> {
   return new Promise((resolve) => {
      useUiDialogStore.getState().show({ kind: "prompt", message, defaultValue, resolve });
   });
}

/**
 * Offer several actions at once (e.g. "Open file" / "Show in folder" after an
 * export). Resolves with the chosen id, or null when dismissed.
 */
export function appChoose(
   message: string,
   choices: DialogChoice[],
   options: { title?: string; cancelLabel?: string } = {},
): Promise<string | null> {
   return new Promise((resolve) => {
      useUiDialogStore.getState().show({
         kind: "choice",
         message,
         choices,
         title: options.title,
         cancelLabel: options.cancelLabel ?? "Close",
         resolve,
      });
   });
}
