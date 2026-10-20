import { errorMessage } from "@/lib/utils";
import { useEffect, useMemo, useState } from "react";
import {
   Copy,
   Download,
   Eye,
   FolderOpen,
   FolderTree,
   History,
   Music2,
   RefreshCw,
   Search,
   Trash2,
} from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Thumbnail } from "@/components/Thumbnail";
import {
   Select,
   SelectContent,
   SelectItem,
   SelectTrigger,
   SelectValue,
} from "@/components/ui/select";
import {
   Dialog,
   DialogContent,
   DialogDescription,
   DialogFooter,
   DialogHeader,
   DialogTitle,
} from "@/components/ui/dialog";
import { useHistoryStore } from "@/stores/history";
import { useQueueStore } from "@/stores/queue";
import { openInStudio } from "@/stores/studio";
import { useAppStore } from "@/stores/app";
import { api, clipboard } from "@/lib/api";
import type { DownloadRequest } from "@/lib/types";
import { toast } from "@/stores/toast";
import { appConfirm } from "@/stores/uiDialog";
import {
   formatBytes,
   formatDuration,
   formatTimeAgo,
   qualityLabel,
} from "@/lib/format";

export function HistoryView() {
   const { items, loaded, refresh } = useHistoryStore();
   const query = useHistoryStore((s) => s.query);
   const formatFilter = useHistoryStore((s) => s.formatFilter);
   const statusFilter = useHistoryStore((s) => s.statusFilter);
   const sort = useHistoryStore((s) => s.sort);
   const loadError = useHistoryStore((s) => s.error);

   useEffect(() => {
      refresh();
   }, [query, formatFilter, statusFilter, sort]);

   // Downloads that older versions saved into accidental sub-folders.
   const [misplaced, setMisplaced] = useState(0);
   const [tidying, setTidying] = useState(false);
   useEffect(() => {
      api.tidyDownloadFolders(true)
         .then((r) => setMisplaced(r.found))
         .catch(() => setMisplaced(0));
   }, [items.length]);

   const tidyUp = async () => {
      const ok = await appConfirm(
         `${misplaced} ${misplaced === 1 ? "song was" : "songs were"} saved inside extra folders because ${misplaced === 1 ? "its title" : "their titles"} contained a slash. Amen will move ${misplaced === 1 ? "it" : "them"} back into your download folder under the full title and remove the folders left empty. Nothing else in those folders is touched.`,
         { title: "Tidy up download folders?", confirmLabel: "Tidy up" },
      );
      if (!ok) return;
      setTidying(true);
      try {
         const r = await api.tidyDownloadFolders(false);
         await refresh();
         setMisplaced(r.found - r.moved);
         if (r.failed.length) {
            toast(
               `Moved ${r.moved}, ${r.failed.length} couldn't be moved`,
               r.failed.slice(0, 3).join("; "),
               "destructive",
            );
         } else {
            toast(
               "Download folder tidied",
               `Moved ${r.moved} ${r.moved === 1 ? "song" : "songs"} and removed ${r.removedFolders} empty ${r.removedFolders === 1 ? "folder" : "folders"}.`,
               "success",
            );
         }
      } catch (e) {
         toast("Couldn't tidy up", errorMessage(e), "destructive");
      } finally {
         setTidying(false);
      }
   };

   const stats = useMemo(() => {
      const total = items.length;
      const size = items.reduce((acc, i) => acc + (i.fileSize ?? 0), 0);
      return { total, size };
   }, [items]);

   return (
      <div className="mx-auto max-w-6xl space-y-4 px-8 py-6">
         <div className="flex items-end justify-between">
            <div>
               <h1 className="text-xl font-semibold tracking-tight">History</h1>
               <p className="text-sm text-muted-foreground">
                  {loaded ? (
                     <>
                        {stats.total} item{stats.total === 1 ? "" : "s"} ·{" "}
                        {formatBytes(stats.size)} downloaded
                     </>
                  ) : (
                     "Loading…"
                  )}
               </p>
            </div>
            {items.length > 0 && (
               <Button
                  variant="outline"
                  size="sm"
                  onClick={async () => {
                     const ok = await appConfirm(
                        "Every entry will be removed from your download history. The downloaded files on disk are not deleted.",
                        { title: "Clear history?", confirmLabel: "Clear history", destructive: true },
                     );
                     if (!ok) return;
                     try {
                        await useHistoryStore.getState().clearAll();
                        toast(
                           "Cleared",
                           "Download history cleared. Files were not deleted.",
                           "success",
                        );
                     } catch (e) {
                        toast("Couldn't clear history", errorMessage(e), "destructive");
                     }
                  }}
               >
                  <Trash2 className="h-3.5 w-3.5" />
                  Clear history
               </Button>
            )}
         </div>

         {misplaced > 0 && (
            <div className="flex flex-wrap items-center gap-3 rounded-xl border border-warning/30 bg-warning/10 px-4 py-3 text-sm">
               <FolderTree className="h-4 w-4 shrink-0 text-warning" />
               <span className="min-w-0 flex-1">
                  {misplaced} {misplaced === 1 ? "song is" : "songs are"} stored in extra folders created by an older version.
               </span>
               <Button size="sm" variant="outline" onClick={tidyUp} disabled={tidying}>
                  {tidying ? "Tidying…" : "Tidy up"}
               </Button>
            </div>
         )}

         {/* Filters */}
         <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-[220px] flex-1">
               <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
               <Input
                  className="pl-8"
                  placeholder="Search by title or URL…"
                  value={query}
                  onChange={(e) =>
                     useHistoryStore.getState().setQuery(e.target.value)
                  }
               />
            </div>
            <Select
               value={formatFilter}
               onValueChange={(v) =>
                  useHistoryStore.getState().setFormatFilter(v)
               }
            >
               <SelectTrigger className="w-28">
                  <SelectValue placeholder="Format" />
               </SelectTrigger>
               <SelectContent>
                  <SelectItem value="all">All formats</SelectItem>
                  <SelectItem value="mp3">MP3</SelectItem>
                  <SelectItem value="mp4">MP4</SelectItem>
               </SelectContent>
            </Select>
            <Select
               value={statusFilter}
               onValueChange={(v) =>
                  useHistoryStore.getState().setStatusFilter(v)
               }
            >
               <SelectTrigger className="w-32">
                  <SelectValue placeholder="Status" />
               </SelectTrigger>
               <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  <SelectItem value="completed">Completed</SelectItem>
                  <SelectItem value="skipped">Skipped</SelectItem>
                  <SelectItem value="failed">Failed</SelectItem>
               </SelectContent>
            </Select>
            <Select
               value={sort}
               onValueChange={(v) => useHistoryStore.getState().setSort(v)}
            >
               <SelectTrigger className="w-32">
                  <SelectValue placeholder="Sort" />
               </SelectTrigger>
               <SelectContent>
                  <SelectItem value="date">Newest first</SelectItem>
                  <SelectItem value="title">By title</SelectItem>
                  <SelectItem value="format">By format</SelectItem>
               </SelectContent>
            </Select>
            <Button
               variant="ghost"
               size="icon"
               onClick={refresh}
               aria-label="Refresh history"
            >
               <RefreshCw className="h-4 w-4" />
            </Button>
         </div>

         {loadError && (
            <div className="flex flex-wrap items-center gap-3 rounded-xl border border-destructive/25 bg-destructive/8 px-4 py-3 text-sm">
               <span className="flex-1 text-destructive">
                  Couldn't load your history: {loadError}
               </span>
               <Button variant="outline" size="sm" onClick={refresh}>
                  <RefreshCw className="h-3.5 w-3.5" />
                  Retry
               </Button>
            </div>
         )}

         {items.length === 0 ? (
            loadError ? null : (
               <EmptyState
                  icon={History}
                  title="No history yet"
                  description="Completed downloads will appear here so you can find them again quickly."
               />
            )
         ) : (
            <div className="space-y-2">
               {items.map((item) => (
                  <HistoryRow
                     key={item.id}
                     id={item.id}
                  />
               ))}
            </div>
         )}
      </div>
   );
}

function HistoryRow({ id }: { id: string }) {
   const item = useHistoryStore((s) => s.items.find((i) => i.id === id));
   const [confirmDelete, setConfirmDelete] = useState(false);
   const [removing, setRemoving] = useState(false);
   const setView = useAppStore((s) => s.setView);

   if (!item) return null;

   // A skipped entry still points at a real file (it was skipped BECAUSE the
   // file already exists), so it gets the same file actions as a completed one.
   const hasFile =
      (item.status === "completed" || item.status === "skipped") && !!item.filePath;

   const openFile = async () => {
      try {
         await api.openFile(item.filePath);
      } catch (e) {
         toast("Couldn't open the file", errorMessage(e), "destructive");
      }
   };

   const reveal = async () => {
      try {
         await api.revealInFolder(item.filePath);
      } catch (e) {
         toast("Couldn't show the file in its folder", errorMessage(e), "destructive");
      }
   };

   const copyUrl = async () => {
      try {
         await clipboard.writeText(item.url);
         toast("Copied", "Source URL copied to clipboard.", "success");
      } catch (e) {
         toast("Couldn't copy", errorMessage(e), "destructive");
      }
   };

   const downloadAgain = async () => {
      try {
         const request: DownloadRequest = {
            url: item.url,
            format: item.format,
            quality: item.quality,
            title: item.title,
            thumbnail: item.thumbnail,
            mediaId: item.mediaId ?? null,
            extractor: item.extractor,
            duration: item.duration,
            // An explicit "download again" must not be swallowed by the
            // duplicate check that put this entry in history to begin with.
            force: true,
         };
         const job = await api.startDownload(request);
         useQueueStore.getState().upsert(job);
         setView("downloads");
         toast("Downloading again", item.title ?? undefined, "success");
      } catch (e) {
         toast("Couldn't download again", errorMessage(e), "destructive");
      }
   };

   const remove = async () => {
      setRemoving(true);
      try {
         await useHistoryStore.getState().removeItem(id);
         setConfirmDelete(false);
      } catch (e) {
         toast("Couldn't remove from history", errorMessage(e), "destructive");
      } finally {
         setRemoving(false);
      }
   };

   return (
      <div className="flex items-center gap-4 rounded-xl border border-border bg-card p-3">
         <Thumbnail
            src={item.thumbnail}
            className="h-12 w-20 shrink-0"
            rounded="rounded-md"
         />
         <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
               <span className="truncate text-sm font-medium">
                  {item.title ?? "Untitled media"}
               </span>
               <Badge
                  variant="muted"
                  className="shrink-0"
               >
                  {item.format.toUpperCase()}
               </Badge>
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
               <span>{formatTimeAgo(item.createdAt)}</span>
               <span>{qualityLabel(item.quality)}</span>
               {item.fileSize != null && (
                  <span>{formatBytes(item.fileSize)}</span>
               )}
               {item.duration != null && (
                  <span>{formatDuration(item.duration)}</span>
               )}
               {item.status === "skipped" && (
                  <span className="text-warning">Skipped — already downloaded</span>
               )}
               {hasFile && (
                  <span
                     className="truncate text-muted-foreground/70"
                     title={item.filePath}
                  >
                     {item.filePath}
                  </span>
               )}
            </div>
         </div>
         <div className="flex shrink-0 items-center gap-1">
            {hasFile && (
               <>
                  <RowButton label="Open file" onClick={openFile}>
                     <Eye className="h-4 w-4" />
                  </RowButton>
                  <RowButton label="Show in folder" onClick={reveal}>
                     <FolderOpen className="h-4 w-4" />
                  </RowButton>
                  {/* Only MP3 downloads are audio; MP4 is video. */}
                  {item.format === "mp3" && (
                     <RowButton
                        label="Open in Audio Studio"
                        onClick={() => openInStudio(item.filePath, item.title)}
                     >
                        <Music2 className="h-4 w-4" />
                     </RowButton>
                  )}
               </>
            )}
            <RowButton label="Copy source URL" onClick={copyUrl}>
               <Copy className="h-4 w-4" />
            </RowButton>
            <RowButton
               label="Download again"
               onClick={downloadAgain}
            >
               <Download className="h-4 w-4" />
            </RowButton>
            <RowButton
               label="Remove from history"
               onClick={() => setConfirmDelete(true)}
            >
               <Trash2 className="h-4 w-4 text-destructive" />
            </RowButton>
         </div>

         <Dialog
            open={confirmDelete}
            onOpenChange={setConfirmDelete}
         >
            <DialogContent className="max-w-sm">
               <DialogHeader>
                  <DialogTitle>Remove from history?</DialogTitle>
                  <DialogDescription>
                     The downloaded file on disk will <strong>not</strong> be
                     deleted. Only this history entry is removed.
                  </DialogDescription>
               </DialogHeader>
               <DialogFooter>
                  <Button
                     variant="outline"
                     onClick={() => setConfirmDelete(false)}
                  >
                     Cancel
                  </Button>
                  <Button
                     variant="destructive"
                     disabled={removing}
                     onClick={remove}
                  >
                     Remove
                  </Button>
               </DialogFooter>
            </DialogContent>
         </Dialog>
      </div>
   );
}

function RowButton({
   label,
   onClick,
   children,
}: {
   label: string;
   onClick: () => void;
   children: React.ReactNode;
}) {
   return (
      <button
         onClick={onClick}
         className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
         title={label}
         aria-label={label}
      >
         {children}
      </button>
   );
}
