// URL handling (pure, unit-testable). yt-dlp remains the authority on whether
// a URL is actually supported — these helpers only tidy up user input.

const YT_HOSTS = [
   "youtube.com",
   "www.youtube.com",
   "m.youtube.com",
   "youtu.be",
   "music.youtube.com",
];

function hostOf(url: string): string | null {
   try {
      const u = new URL(url);
      return u.hostname.toLowerCase();
   } catch {
      return null;
   }
}

export function isHttpUrl(input: string): boolean {
   const t = input.trim();
   try {
      const u = new URL(t);
      return u.protocol === "http:" || u.protocol === "https:";
   } catch {
      return false;
   }
}

/** Light normalization — strips tracking params that don't change the media. */
export function normalizeUrl(input: string): string {
   const t = input.trim();
   if (!isHttpUrl(t)) return t;
   try {
      const u = new URL(t);
      const host = hostOf(t);
      if (YT_HOSTS.includes(host ?? "")) {
         const remove = new Set([
            "si",
            "feature",
            "utm_source",
            "utm_medium",
            "utm_campaign",
            "utm_content",
            "utm_term",
         ]);
         for (const key of [...u.searchParams.keys()]) {
            if (remove.has(key)) u.searchParams.delete(key);
         }
         // Normalize youtu.be/shorts/live/watch to the canonical watch form where possible
         if (host === "youtu.be") {
            const id = u.pathname.split("/").filter(Boolean)[0];
            if (id) {
               const v = u.searchParams.get("v");
               return `https://www.youtube.com/watch?v=${v ?? id}`;
            }
         }
      }
      return u.toString();
   } catch {
      return t;
   }
}

export function looksLikePlaylist(url: string): boolean {
   try {
      const u = new URL(url);
      const host = hostOf(url);
      if (YT_HOSTS.includes(host ?? "")) {
         if (u.searchParams.has("list")) return true;
         const segments = u.pathname.split("/").filter(Boolean);
         return ["playlist", "playlists", "set"].includes(segments[0] ?? "");
      }
      return false;
   } catch {
      return false;
   }
}

export function descriptionForError(code: string): string {
   switch (code) {
      case "invalid_url":
         return "Enter a valid http(s) media URL.";
      case "dependency_missing":
         return "A required tool is missing — open Diagnostics to install it.";
      case "analysis_failed":
         return "Could not read metadata from that URL.";
      case "download_failed":
         return "The download failed. See details below.";
      case "invalid_config":
         return "Your configuration needs attention.";
      default:
         return "Something went wrong.";
   }
}

/** A Spotify song, album or playlist link (open.spotify.com, spotify.link or a spotify: URI). */
export function isSpotifyLink(input: string): boolean {
   const t = input.trim();
   if (/^spotify:(track|album|playlist|artist):/i.test(t)) return true;
   const host = hostOf(t);
   return host === "open.spotify.com" || host === "spotify.link" || host?.endsWith(".spotify.link") === true;
}
