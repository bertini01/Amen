import { useMemo, useState } from "react";
import { CheckSquare, ListVideo, Square, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Thumbnail } from "@/components/Thumbnail";
import { DownloadOptions } from "@/components/home/DownloadOptions";
import { formatDuration } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { MediaFormat, PlaylistInfo, QualityOption, DownloadRequest } from "@/lib/types";

interface PlaylistPreviewProps {
   playlist: PlaylistInfo;
   format: MediaFormat;
   setFormat: (f: MediaFormat) => void;
   quality: QualityOption;
   setQuality: (q: QualityOption) => void;
   destination: string;
   onBrowseDestination: () => void;
   onDownload: (
      urls: {
         url: string;
         title: string | null;
         thumbnail: string | null;
         index: number | null;
         extra?: Partial<DownloadRequest>;
      }[],
   ) => void;
   downloading: boolean;
}

export function PlaylistPreview({
   playlist,
   format,
   setFormat,
   quality,
   setQuality,
   destination,
   onBrowseDestination,
   onDownload,
   downloading,
}: PlaylistPreviewProps) {
   const entries = playlist.entries;
   // For search results, show 5 by default, for playlists show 30
   const isSearch = playlist.extractor?.toLowerCase().includes("search") ?? false;
   // A search is a list of alternatives: pre-select only the top result, or
   // one click saved five versions of the same song.
   const [selected, setSelected] = useState<Set<string>>(() => {
      const ids = entries.filter((e) => e.id).map((e) => e.id as string);
      return new Set(isSearch ? ids.slice(0, 1) : ids);
   });
   const [showAll, setShowAll] = useState(false);
   const defaultVisible = isSearch ? 5 : 30;

   const toggle = (id: string) => {
      setSelected((prev) => {
         const next = new Set(prev);
         if (next.has(id)) next.delete(id);
         else next.add(id);
         return next;
      });
   };

   const selectAll = () =>
      setSelected(
         new Set(entries.filter((e) => e.id).map((e) => e.id as string)),
      );
   const clearSelection = () => setSelected(new Set());

   const selectedEntries = useMemo(
      () => entries.filter((e) => e.id && selected.has(e.id)),
      [entries, selected],
   );

   const visible = showAll ? entries : entries.slice(0, defaultVisible);

   return (
      <div className="animate-slide-up overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
         <div className="flex items-start justify-between gap-4 p-5 pb-3">
            <div className="min-w-0">
               <h2 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
                  <ListVideo className="h-5 w-5 text-primary" />
                  {playlist.title ?? "Playlist"}
               </h2>
               <div className="mt-1 flex items-center gap-3 text-[13px] text-muted-foreground">
                  {playlist.uploader && (
                     <span className="inline-flex items-center gap-1.5">
                        <User className="h-3.5 w-3.5" />
                        {playlist.uploader}
                     </span>
                  )}
                  <span>{entries.length} items</span>
               </div>
            </div>
            <div className="flex shrink-0 gap-2">
               <Button
                  variant="outline"
                  size="sm"
                  onClick={selectAll}
               >
                  <CheckSquare className="h-3.5 w-3.5" />
                  Select all
               </Button>
               <Button
                  variant="ghost"
                  size="sm"
                  onClick={clearSelection}
               >
                  <Square className="h-3.5 w-3.5" />
                  Clear
               </Button>
            </div>
         </div>

         <div className="max-h-[320px] space-y-1 overflow-y-auto px-3">
            {visible.map((e, i) => {
               const id = e.id ?? `${e.title ?? "item"}-${i}`;
               const on = e.id != null && selected.has(e.id);
               return (
                  <button
                     key={id}
                     onClick={() => e.id && toggle(e.id)}
                     className={cn(
                        "flex w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left transition-colors",
                        on ? "bg-accent/70" : "hover:bg-accent/40",
                     )}
                  >
                     <Thumbnail
                        src={e.thumbnail}
                        className="h-10 w-16 shrink-0"
                        rounded="rounded-md"
                     />
                     <div className="min-w-0 flex-1">
                        <div className="truncate text-[13px] font-medium text-foreground">
                           {e.title ?? "Untitled item"}
                        </div>
                        <div className="truncate text-[11px] text-muted-foreground">
                           {e.uploader ?? e.channel ?? "—"}
                        </div>
                     </div>
                     <div className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                        {formatDuration(e.duration)}
                     </div>
                     <div
                        className={cn(
                           "flex h-5 w-5 shrink-0 items-center justify-center rounded-md border transition-colors",
                           on
                              ? "border-primary bg-primary text-primary-foreground"
                              : "border-border bg-background",
                        )}
                     >
                        {on && <CheckSquare className="h-3.5 w-3.5" />}
                     </div>
                  </button>
               );
            })}
            {entries.length > defaultVisible && (
               <button
                  onClick={() => setShowAll((v) => !v)}
                  className="w-full py-2 text-center text-xs font-medium text-primary hover:underline"
               >
                  {showAll ? "Show fewer" : `Show all ${entries.length} items`}
               </button>
            )}
         </div>

         <div className="border-t border-border/70 p-5">
            <p className="mb-3 text-xs text-muted-foreground">
               {selectedEntries.length} of {entries.length} items will be
               downloaded
               {selectedEntries.length > 0 ? " — one file per item." : "."}
            </p>
            <DownloadOptions
               format={format}
               setFormat={setFormat}
               quality={quality}
               setQuality={setQuality}
               destination={destination}
               onBrowseDestination={onBrowseDestination}
               onDownload={() =>
                  onDownload(
                     // An entry without its own link is skipped: falling back
                     // to the playlist link downloaded a different song.
                     selectedEntries
                        .filter((e) => e.webpageUrl ?? e.originalUrl)
                        .map((e) => ({
                           url: (e.webpageUrl ?? e.originalUrl)!,
                           title: e.title,
                           thumbnail: e.thumbnail,
                           index: e.playlistIndex ?? e.trackNumber,
                           extra: { mediaId: e.id, duration: e.duration },
                        })),
                  )
               }
               downloading={downloading}
               itemCount={selectedEntries.length}
            />
         </div>
      </div>
   );
}
