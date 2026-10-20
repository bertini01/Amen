// Ranking search results against a song described by a streaming service
// (pure, unit-testable). The user always makes the final choice; this only
// decides which result is pre-selected and labelled "Best match".

import type { MediaInfo, MusicTrack } from "@/lib/types";

/** Words that mark a different version of a song than the one asked for. */
const VARIANT_WORDS = [
   "live",
   "remix",
   "cover",
   "karaoke",
   "instrumental",
   "acoustic",
   "sped",
   "slowed",
   "reverb",
   "8d",
   "nightcore",
   "lyrics",
   "reaction",
   "tutorial",
   "piano",
];

function words(text: string | null | undefined): string[] {
   return (text ?? "")
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length > 1);
}

export interface RankedMatch {
   media: MediaInfo;
   score: number;
   /** Result length minus the song's length, in seconds (null when unknown). */
   durationDelta: number | null;
}

/** Higher is better. Exported for tests. */
export function scoreMatch(track: MusicTrack, media: MediaInfo): RankedMatch {
   const wanted = new Set([...words(track.title), ...words(track.artists)]);
   const titleWords = words(track.title);
   const got = new Set([
      ...words(media.title),
      ...words(media.uploader),
      ...words(media.channel),
   ]);

   let score = 0;

   // Every title word present is worth a lot; artist words a little less.
   const titleHits = titleWords.filter((w) => got.has(w)).length;
   score += titleWords.length ? (titleHits / titleWords.length) * 50 : 0;
   const otherHits = [...wanted].filter((w) => !titleWords.includes(w) && got.has(w)).length;
   score += otherHits * 6;

   // Official uploads are usually the cleanest audio.
   const label = `${media.channel ?? ""} ${media.uploader ?? ""} ${media.title ?? ""}`.toLowerCase();
   if (/- topic\b|official audio|\bvevo\b/.test(label)) score += 12;

   // A different version of the song (live, remix, karaoke…) is a worse match
   // unless the song itself is that version.
   const asked = new Set(words(`${track.title} ${track.artists}`));
   for (const w of VARIANT_WORDS) {
      if (got.has(w) && !asked.has(w)) score -= 15;
   }

   // Same length is the strongest single signal.
   let durationDelta: number | null = null;
   if (track.duration != null && media.duration != null) {
      durationDelta = media.duration - track.duration;
      const off = Math.abs(durationDelta);
      if (off <= 3) score += 30;
      else if (off <= 10) score += 18;
      else if (off <= 30) score += 5;
      else score -= Math.min(30, off / 10);
   }

   return { media, score, durationDelta };
}

/** Results best-first. Ties keep the search engine's order. */
export function rankMatches(track: MusicTrack, results: MediaInfo[]): RankedMatch[] {
   return results
      .map((media, i) => ({ ranked: scoreMatch(track, media), i }))
      .sort((a, b) => b.ranked.score - a.ranked.score || a.i - b.i)
      .map(({ ranked }) => ranked);
}

/** "Same length", "12s longer", "1:05 shorter". */
export function describeDelta(delta: number | null): string | null {
   if (delta == null) return null;
   const off = Math.round(Math.abs(delta));
   if (off <= 3) return "Same length";
   const amount = off >= 60 ? `${Math.floor(off / 60)}:${String(off % 60).padStart(2, "0")}` : `${off}s`;
   return `${amount} ${delta > 0 ? "longer" : "shorter"}`;
}
