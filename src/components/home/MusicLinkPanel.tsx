import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
   Check,
   ExternalLink,
   ListMusic,
   Lock,
   RefreshCw,
   Search,
   Sparkles,
} from "lucide-react";
import { Thumbnail } from "@/components/Thumbnail";
import { DownloadOptions } from "@/components/home/DownloadOptions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useAppStore } from "@/stores/app";
import { api } from "@/lib/api";
import { describeDelta, rankMatches, type RankedMatch } from "@/lib/musicMatch";
import { formatDuration } from "@/lib/format";
import { cn, errorMessage } from "@/lib/utils";
import type { MediaFormat, MediaInfo, MusicTrack, QualityOption } from "@/lib/types";

/** Spotify's brand green, used only for the service badge. */
const SPOTIFY_GREEN = "#1DB954";

interface MusicLinkPanelProps {
   format: MediaFormat;
   setFormat: (f: MediaFormat) => void;
   quality: QualityOption;
   setQuality: (q: QualityOption) => void;
   destination: string;
   onBrowseDestination: () => void;
   /** Queue the chosen version, tagged with the song's own title and artist. */
   onSave: (match: MediaInfo, track: MusicTrack, album: string | null, cover: string | null) => void;
   downloading: boolean;
}

/**
 * A Spotify song, album or playlist. Its audio is copy-protected, so this
 * shows what the link describes and lets the user choose, per song, a version
 * from a site that allows saving.
 */
export function MusicLinkPanel(props: MusicLinkPanelProps) {
   const link = useAppStore((s) => s.musicLink);
   const trackIndex = useAppStore((s) => s.musicTrackIndex);
   const findMusicTrack = useAppStore((s) => s.findMusicTrack);
   if (!link) return null;

   const isSingle = link.kind === "track";
   const track = trackIndex != null ? link.tracks[trackIndex] : null;
   const kindLabel = isSingle ? "Song" : link.kind === "album" ? "Album" : "Playlist";
   const total = link.tracks.reduce((sum, t) => sum + (t.duration ?? 0), 0);

   return (
      <div className="animate-slide-up overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
         {/* What the link is */}
         <div className="flex flex-col gap-5 p-5 sm:flex-row">
            <Thumbnail
               src={link.cover}
               alt={link.title}
               className="aspect-square w-full shadow-lg sm:w-36"
               rounded="rounded-xl"
            />
            <div className="flex min-w-0 flex-1 flex-col">
               <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider">
                  <span
                     className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5"
                     style={{ color: SPOTIFY_GREEN, backgroundColor: `${SPOTIFY_GREEN}1f` }}
                  >
                     <span
                        className="h-1.5 w-1.5 rounded-full"
                        style={{ backgroundColor: SPOTIFY_GREEN }}
                     />
                     {link.service}
                  </span>
                  <span className="text-muted-foreground">{kindLabel}</span>
               </div>
               <h2 className="mt-2 text-xl font-semibold leading-snug tracking-tight text-balance">
                  {link.title}
               </h2>
               <p className="mt-1 text-[13px] text-muted-foreground">
                  {[
                     link.subtitle,
                     isSingle
                        ? formatDuration(link.tracks[0]?.duration ?? null)
                        : `${link.tracks.length} songs${total ? ` · ${formatDuration(total)}` : ""}`,
                  ]
                     .filter(Boolean)
                     .join(" · ")}
               </p>
               <div className="mt-auto flex items-start gap-2 rounded-lg bg-muted/60 p-3 text-[12.5px] leading-relaxed text-muted-foreground sm:mt-4">
                  <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>
                     {link.service} songs are copy-protected, so Amen can't save them directly.
                     {isSingle
                        ? " It searched for this song on sites that allow saving. Pick the version that's right."
                        : " Choose a song below and Amen will find versions you can save."}
                  </span>
               </div>
            </div>
         </div>

         {/* Album / playlist: choose a song */}
         {!isSingle && (
            <div className="border-t border-border/70">
               <div className="flex items-center gap-2 px-5 pt-4 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  <ListMusic className="h-3.5 w-3.5" />
                  Songs
               </div>
               <ol className="max-h-80 overflow-y-auto px-3 py-2">
                  {link.tracks.map((t, i) => {
                     const active = i === trackIndex;
                     return (
                        <li key={`${i}-${t.title}`}>
                           <button
                              onClick={() => findMusicTrack(i)}
                              className={cn(
                                 "group flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors",
                                 active ? "bg-primary/10" : "hover:bg-accent",
                              )}
                           >
                              <span
                                 className={cn(
                                    "w-6 shrink-0 text-right text-[12px] tabular-nums",
                                    active ? "text-primary" : "text-muted-foreground",
                                 )}
                              >
                                 {i + 1}
                              </span>
                              <span className="min-w-0 flex-1">
                                 <span
                                    className={cn(
                                       "block truncate text-[13px] font-medium",
                                       active && "text-primary",
                                    )}
                                 >
                                    {t.title}
                                 </span>
                                 <span className="block truncate text-[12px] text-muted-foreground">
                                    {t.artists}
                                 </span>
                              </span>
                              <span className="shrink-0 text-[12px] tabular-nums text-muted-foreground">
                                 {formatDuration(t.duration)}
                              </span>
                              <span
                                 className={cn(
                                    "inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[12px] font-medium transition-opacity",
                                    active
                                       ? "text-primary"
                                       : "text-muted-foreground opacity-0 group-hover:opacity-100",
                                 )}
                              >
                                 <Search className="h-3.5 w-3.5" />
                                 Find
                              </span>
                           </button>
                        </li>
                     );
                  })}
               </ol>
            </div>
         )}

         {/* Matches for the chosen song */}
         {track && (
            <Matches
               key={`${trackIndex}-${track.query}`}
               track={track}
               album={link.kind === "album" ? link.title : null}
               cover={link.cover}
               {...props}
            />
         )}
      </div>
   );
}

function Matches({
   track,
   album,
   cover,
   format,
   setFormat,
   quality,
   setQuality,
   destination,
   onBrowseDestination,
   onSave,
   downloading,
}: MusicLinkPanelProps & { track: MusicTrack; album: string | null; cover: string | null }) {
   const searching = useAppStore((s) => s.musicSearching);
   const storeMatches = useAppStore((s) => s.musicMatches);
   const error = useAppStore((s) => s.musicError);

   // The user can refine the search; results then replace the store's.
   const [query, setQuery] = useState(track.query);
   const [custom, setCustom] = useState<RankedMatch[] | null>(null);
   const [customSearching, setCustomSearching] = useState(false);
   const [customError, setCustomError] = useState<string | null>(null);
   const matches = custom ?? storeMatches;
   const busy = searching || customSearching;

   const [chosen, setChosen] = useState<string | null>(null);
   useEffect(() => {
      setChosen(matches?.[0]?.media.webpageUrl ?? null);
   }, [matches]);

   const searchAgain = async () => {
      const q = query.trim();
      if (!q) return;
      setCustomSearching(true);
      setCustomError(null);
      try {
         const result = await api.analyzeUrl(q);
         const entries =
            result !== "Unsupported" && "Playlist" in result
               ? result.Playlist.entries
               : result !== "Unsupported" && "Media" in result
                 ? [result.Media]
                 : [];
         setCustom(rankMatches(track, entries));
      } catch (e) {
         setCustomError(errorMessage(e));
      } finally {
         setCustomSearching(false);
      }
   };

   const picked = matches?.find((m) => m.media.webpageUrl === chosen)?.media ?? null;
   const failure = customError ?? (error ? errorMessage(error) : null);

   return (
      <div className="border-t border-border/70 p-5">
         <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
               Versions you can save
            </div>
            <form
               className="flex min-w-0 flex-1 items-center gap-2 sm:max-w-md"
               onSubmit={(e) => {
                  e.preventDefault();
                  searchAgain();
               }}
            >
               <div className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-lg border border-border bg-background/60 px-2.5">
                  <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <input
                     value={query}
                     onChange={(e) => setQuery(e.target.value)}
                     className="min-w-0 flex-1 bg-transparent text-[12.5px] outline-none"
                     aria-label="Search for this song"
                     spellCheck={false}
                  />
               </div>
               <Button
                  type="submit"
                  size="sm"
                  variant="outline"
                  className="h-8 gap-1.5"
                  disabled={busy}
               >
                  <RefreshCw className={cn("h-3.5 w-3.5", busy && "animate-spin")} />
                  Search
               </Button>
            </form>
         </div>

         <div className="mt-3 space-y-1.5">
            {busy &&
               Array.from({ length: 3 }, (_, i) => (
                  <div
                     key={i}
                     className="flex items-center gap-3 rounded-xl border border-border/60 p-2.5"
                  >
                     <Skeleton className="h-12 w-20 rounded-md" />
                     <div className="flex-1 space-y-2">
                        <Skeleton className="h-3.5 w-2/3" />
                        <Skeleton className="h-3 w-1/3" />
                     </div>
                  </div>
               ))}

            {!busy && failure && (
               <p className="rounded-lg border border-destructive/25 bg-destructive/5 p-3 text-[13px] text-destructive">
                  {failure}
               </p>
            )}

            {!busy && !failure && matches?.length === 0 && (
               <p className="rounded-lg bg-muted/60 p-3 text-[13px] text-muted-foreground">
                  No versions found. Try a different search above, for example just the song title.
               </p>
            )}

            {!busy &&
               matches?.map((m, i) => (
                  <MatchRow
                     key={m.media.webpageUrl ?? i}
                     match={m}
                     best={i === 0}
                     selected={m.media.webpageUrl === chosen}
                     onSelect={() => setChosen(m.media.webpageUrl)}
                  />
               ))}
         </div>

         {picked && (
            <div className="mt-4 border-t border-border/70 pt-4">
               <DownloadOptions
                  format={format}
                  setFormat={setFormat}
                  quality={quality}
                  setQuality={setQuality}
                  destination={destination}
                  onBrowseDestination={onBrowseDestination}
                  sourceBitrate={picked.bestAudioBitrate}
                  onDownload={() => onSave(picked, track, album, cover)}
                  downloading={downloading}
               />
            </div>
         )}
      </div>
   );
}

function MatchRow({
   match,
   best,
   selected,
   onSelect,
}: {
   match: RankedMatch;
   best: boolean;
   selected: boolean;
   onSelect: () => void;
}) {
   const { media, durationDelta } = match;
   const delta = describeDelta(durationDelta);
   const sameLength = delta === "Same length";
   return (
      <div
         role="radio"
         aria-checked={selected}
         tabIndex={0}
         onClick={onSelect}
         onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onSelect()}
         className={cn(
            "group flex cursor-pointer items-center gap-3 rounded-xl border p-2.5 transition-colors",
            selected
               ? "border-primary/50 bg-primary/[0.07] ring-1 ring-primary/25"
               : "border-border/60 hover:border-border hover:bg-accent/50",
         )}
      >
         <span
            className={cn(
               "flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded-full border",
               selected ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/40",
            )}
         >
            {selected && <Check className="h-3 w-3" strokeWidth={3} />}
         </span>
         <Thumbnail
            src={media.thumbnail}
            alt={media.title ?? ""}
            className="h-12 w-20"
            rounded="rounded-md"
         />
         <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
               <span className="truncate text-[13px] font-medium">{media.title ?? "Untitled"}</span>
               {best && (
                  <Badge variant="default" className="shrink-0 gap-1 py-0 text-[10.5px]">
                     <Sparkles className="h-3 w-3" />
                     Best match
                  </Badge>
               )}
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[12px] text-muted-foreground">
               {(media.channel ?? media.uploader) && <span>{media.channel ?? media.uploader}</span>}
               {media.duration != null && <span>· {formatDuration(media.duration)}</span>}
               {delta && (
                  <span className={sameLength ? "text-success" : undefined}>· {delta}</span>
               )}
            </div>
         </div>
         {media.webpageUrl && (
            <button
               onClick={(e) => {
                  e.stopPropagation();
                  openUrl(media.webpageUrl!).catch(() => undefined);
               }}
               className="shrink-0 rounded-md p-1.5 text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover:opacity-100"
               title="Listen in your browser first"
               aria-label="Listen in your browser first"
            >
               <ExternalLink className="h-4 w-4" />
            </button>
         )}
      </div>
   );
}
