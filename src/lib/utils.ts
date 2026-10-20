import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
   return twMerge(clsx(inputs));
}

/**
 * Readable text for anything thrown across the Tauri boundary. Rust errors
 * arrive as plain `{code, message, detail}` objects, not `Error` instances, so
 * `(e as Error).message` alone renders them as "undefined" or "[object Object]".
 */
export function errorMessage(e: unknown): string {
   if (typeof e === "string") return e;
   if (e && typeof e === "object") {
      const o = e as { message?: unknown; detail?: unknown };
      const msg = typeof o.message === "string" ? o.message : null;
      const detail = typeof o.detail === "string" ? o.detail : null;
      if (msg && detail && detail !== msg) return `${msg} — ${detail}`;
      if (msg) return msg;
      if (detail) return detail;
   }
   return "Unexpected error";
}
