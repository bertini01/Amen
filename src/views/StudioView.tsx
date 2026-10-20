import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
   AUDIO_EXTENSIONS,
   importAudioFiles,
   partitionAudioPaths,
   useStudioStore,
} from "../stores/studio";
import { WaveformView } from "../components/WaveformView";
import { PlayerBar } from "../components/PlayerBar";
import { Timeline, type DropHover } from "../components/Timeline";
import { SourcePanel } from "../components/SourcePanel";
import { ClipLibrary } from "../components/ClipLibrary";
import { ExportDialog } from "../components/ExportDialog";
import { TimeInput } from "../components/TimeInput";
import {
   Plus,
   Save,
   RotateCcw,
   RotateCw,
   FolderOpen,
   FilePlus,
   Play,
   GripHorizontal,
   Repeat,
   Flag,
   X,
   CornerDownRight,
   AlertTriangle,
   Loader2,
} from "lucide-react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { save, open } from "../lib/dialog";
import { api } from "../lib/api";
import { formatTime, formatClock, formatDuration } from "../lib/studioTime";
import { computeCompositionStats } from "../lib/studioTypes";
import { appAlert, appChoose, appConfirm, useUiDialogStore } from "../stores/uiDialog";
import { toast } from "../stores/toast";
import { errorMessage } from "../lib/utils";

const AUDIO_FILTERS = [
   { name: "Audio", extensions: [...AUDIO_EXTENSIONS] },
   { name: "All", extensions: ["*"] },
];


const TIMELINE_FRACTION_KEY = "amen.studio.timelineFraction";
/**
 * The timeline gets the larger share of the workspace by default: it is where
 * the mix is actually built, and the previous fixed-pixel height made it a
 * strip at the bottom of a mostly-empty column on any large display.
 * Stored as a FRACTION of the available column, so a layout tuned on a 1080p
 * window still makes sense on a 1440p one instead of leaving a dead band.
 */
const DEFAULT_TIMELINE_FRACTION = 0.5;
const MIN_TIMELINE_FRACTION = 0.25;
const MAX_TIMELINE_FRACTION = 0.75;
/**
 * Absolute floors, so neither pane can ever be dragged into uselessness.
 * `MIN_TOP_PX` covers everything above the handle: the source editor (whose
 * waveform flexes down to ~56px of canvas) plus the mode row and transport
 * bar, which must stay reachable without scrolling. It is sized so that the
 * always-present Start/End/Create Clip row fits WITHOUT the pane scrolling on
 * an ordinary laptop window — at 400 the waveform was squeezed to its bare
 * floor and the pane scrolled on every size.
 */
const MIN_TIMELINE_PX = 240;
const MIN_TOP_PX = 470;
const RESIZE_HANDLE_HEIGHT = 12;

export function StudioView() {
   const store = useStudioStore();
   const [showExportDialog, setShowExportDialog] = useState(false);
   const [exporting, setExporting] = useState(false);
   const [saving, setSaving] = useState(false);
   const [renamingTitle, setRenamingTitle] = useState(false);

   /** Commit an inline title edit. Escape cancels; blur and Enter both save. */
   const commitTitle = useCallback(
      (value: string) => {
         setRenamingTitle(false);
         store.renameProject(value);
      },
      [store],
   );
   const [dragActive, setDragActive] = useState(false);
   const centerColumnRef = useRef<HTMLDivElement>(null);
   const [columnHeight, setColumnHeight] = useState(0);

   // ---- Resizable timeline panel -------------------------------------------
   const [timelineFraction, setTimelineFraction] = useState<number>(() => {
      const saved = Number(localStorage.getItem(TIMELINE_FRACTION_KEY));
      return Number.isFinite(saved) && saved >= MIN_TIMELINE_FRACTION && saved <= MAX_TIMELINE_FRACTION
         ? saved
         : DEFAULT_TIMELINE_FRACTION;
   });
   const fractionRef = useRef(timelineFraction);
   fractionRef.current = timelineFraction;

   // A plain mount effect isn't enough: on first render `store.project` is
   // still null, so this component returns the loading tree and the ref is
   // never attached. A ResizeObserver re-attaches whenever the real layout
   // appears, and keeps the split honest through live window resizes.
   useEffect(() => {
      const el = centerColumnRef.current;
      if (!el) return;
      const measure = () => setColumnHeight(el.clientHeight);
      measure();
      const ro = new ResizeObserver(measure);
      ro.observe(el);
      return () => ro.disconnect();
   }, [store.project?.sources.length]);

   /** Resolve the fraction into pixels, respecting both panes' absolute floors. */
   const timelineHeight = useMemo(() => {
      if (columnHeight <= 0) return MIN_TIMELINE_PX;
      const usable = columnHeight - RESIZE_HANDLE_HEIGHT;
      const maxTimeline = Math.max(MIN_TIMELINE_PX, usable - MIN_TOP_PX);
      return Math.round(Math.min(maxTimeline, Math.max(MIN_TIMELINE_PX, usable * timelineFraction)));
   }, [columnHeight, timelineFraction]);

   // Attaching listeners directly from the pointerdown handler (rather than
   // via a useEffect keyed on a ref) — refs don't trigger effects to re-run,
   // so a `[someRef.current]` dependency array silently never re-attaches.
   const beginTimelineResize = useCallback(
      (startY: number, startHeight: number) => {
         const usable = Math.max(1, columnHeight - RESIZE_HANDLE_HEIGHT);
         const handleMove = (e: PointerEvent) => {
            const delta = startY - e.clientY; // dragging up grows the timeline
            const next = (startHeight + delta) / usable;
            setTimelineFraction(Math.max(MIN_TIMELINE_FRACTION, Math.min(MAX_TIMELINE_FRACTION, next)));
         };
         const handleUp = () => {
            window.removeEventListener("pointermove", handleMove);
            localStorage.setItem(TIMELINE_FRACTION_KEY, String(fractionRef.current));
         };
         window.addEventListener("pointermove", handleMove);
         window.addEventListener("pointerup", handleUp, { once: true });
      },
      [columnHeight],
   );

   // ---- Pointer-based clip drag: library -> timeline ------------------------
   // HTML5 native drag/drop is unreliable inside the Tauri WebView (repeatedly
   // reported as a disabled-cursor, no-op drop). This tracks the drag with
   // real pointer events instead: a small movement threshold turns a click
   // into a drag, a floating "ghost" follows the cursor, and the Timeline
   // component (which alone knows its own zoom/scroll) resolves the drop
   // target and reports it back via onExternalHoverChange.
   const [dragCandidate, setDragCandidate] = useState<{ clipId: string; name: string; x: number; y: number } | null>(null);
   const [dragClip, setDragClip] = useState<{ clipId: string; name: string; x: number; y: number } | null>(null);
   const dragHoverRef = useRef<DropHover | null>(null);
   const DRAG_THRESHOLD_PX = 5;

   useEffect(() => {
      if (!dragCandidate && !dragClip) return;

      const handleMove = (e: PointerEvent) => {
         if (dragClip) {
            setDragClip((d) => (d ? { ...d, x: e.clientX, y: e.clientY } : d));
            return;
         }
         if (dragCandidate) {
            const dx = e.clientX - dragCandidate.x;
            const dy = e.clientY - dragCandidate.y;
            if (Math.hypot(dx, dy) > DRAG_THRESHOLD_PX) {
               setDragClip({ ...dragCandidate, x: e.clientX, y: e.clientY });
               setDragCandidate(null);
            }
         }
      };
      const handleUp = () => {
         const hover = dragHoverRef.current;
         const active = dragClip;
         if (active && hover) {
            store.addItemToTimeline(active.clipId, hover.trackId, hover.position);
            store.setSelectedTrack(hover.trackId);
         }
         dragHoverRef.current = null;
         setDragCandidate(null);
         setDragClip(null);
      };

      window.addEventListener("pointermove", handleMove);
      window.addEventListener("pointerup", handleUp);
      window.addEventListener("pointercancel", handleUp);
      return () => {
         window.removeEventListener("pointermove", handleMove);
         window.removeEventListener("pointerup", handleUp);
         window.removeEventListener("pointercancel", handleUp);
      };
      // Re-subscribe only when a drag actually starts/stops (candidate seeded,
      // promoted to an active drag, or ended) — NOT on every pointer move.
      // eslint-disable-next-line react-hooks/exhaustive-deps
   }, [dragCandidate?.clipId, dragClip?.clipId]);

   /** The track new clips are appended to: whatever the user last touched, else the first. */
   const activeTrackId =
      store.selection.selectedTrackId ?? store.project?.timeline.tracks[0]?.id ?? null;

   const appendClip = useCallback(
      (clipId: string) => {
         if (!activeTrackId) return;
         store.appendItemToTrack(clipId, activeTrackId);
      },
      [store, activeTrackId],
   );

   // Declare handlers first
   const handleNewProject = async () => {
      if (store.modified && !(await appConfirm("Discard unsaved changes?"))) return;
      await store.newProject("Untitled Mix");
   };

   const handleOpenProject = async () => {
      if (store.modified && !(await appConfirm("Discard unsaved changes?"))) return;
      try {
         const path = await open({
            directory: false,
            filters: [{ name: "Studio Project", extensions: ["lms"] }],
         });
         if (path && typeof path === "string") {
            await store.loadProject(path);
            toast(
               "Project opened",
               `${store.project?.name ?? path.split(/[\\/]/).pop()}`,
               "success",
            );
         }
      } catch (e) {
         toast("Couldn't open that project", errorMessage(e), "destructive");
      }
   };

   // Saving used to be completely silent: no confirmation on success, and a
   // failure only reached console.error — so a save that did not happen looked
   // exactly like one that did.
   const handleSaveProject = async () => {
      if (!store.savedPath) {
         handleSaveProjectAs();
         return;
      }
      try {
         setSaving(true);
         await store.saveProject();
         toast(
            "Project saved",
            `${store.project?.name ?? "Mix"} · ${store.savedPath.split(/[\\/]/).pop()}`,
            "success",
         );
      } catch (e) {
         toast("Couldn't save the project", errorMessage(e), "destructive");
      } finally {
         setSaving(false);
      }
   };

   const handleSaveProjectAs = async () => {
      let path: string | null = null;
      try {
         path = await save({
            defaultPath: `${store.project?.name || "project"}.lms`,
            filters: [{ name: "Studio Project", extensions: ["lms"] }],
         });
      } catch (e) {
         toast("Couldn't open the save dialog", errorMessage(e), "destructive");
         return;
      }
      if (!path) return; // user cancelled — not an error, and not worth a toast
      try {
         setSaving(true);
         await store.saveProjectAs(path);
         toast("Project saved", path.split(/[\\/]/).pop(), "success");
      } catch (e) {
         toast("Couldn't save the project", errorMessage(e), "destructive");
      } finally {
         setSaving(false);
      }
   };

   const handleExportMix = async (format: string, bitrate: number) => {
      const defaultExt = format.toLowerCase();
      let path: string | null;
      try {
         path = await save({
            defaultPath: `${store.project?.name || "mix"}.${defaultExt}`,
            filters: [{ name: format.toUpperCase(), extensions: [defaultExt] }],
         });
      } catch (e) {
         toast("Couldn't open the save dialog", errorMessage(e), "destructive");
         return;
      }
      if (!path) return; // user cancelled

      setExporting(true);
      let result: Awaited<ReturnType<typeof store.exportMix>>;
      try {
         result = await store.exportMix(path, format, bitrate);
      } catch (e) {
         setExporting(false);
         // The store now rethrows the renderer's real reason instead of a
         // bare null, so the user learns WHY (missing source, disk full…).
         await appAlert(`Export failed: ${errorMessage(e)}`, "Export failed");
         return;
      }
      setExporting(false);
      if (!result) {
         await appAlert("Export failed: there is no project open.", "Export failed");
         return;
      }
      setShowExportDialog(false);

      const exported = result.path;
      const name = exported.split(/[\\/]/).pop() ?? exported;
      const sizeMb = (result.sizeBytes / 1024 / 1024).toFixed(1);
      const choice = await appChoose(
         `${name}\n${sizeMb} MB · ${formatClock(result.duration)}`,
         [
            { id: "reveal", label: "Show in folder" },
            { id: "open", label: "Open file", primary: true },
         ],
         { title: "Export complete", cancelLabel: "Close" },
      );
      // Uses the app's own commands — the opener plugin's openPath isn't
      // permitted by this app's capabilities, so it always failed silently.
      try {
         if (choice === "open") await api.openFile(exported);
         else if (choice === "reveal") await api.revealInFolder(exported);
      } catch (e) {
         toast(
            choice === "open" ? "Couldn't open the file" : "Couldn't show the file in its folder",
            errorMessage(e),
            "destructive",
         );
      }
   };

   // ---- File drops (from Explorer) -----------------------------------------
   // Tauri 2's native drag-drop handler swallows HTML5 file drops, and
   // `File.path` only ever existed in Electron, so the old onDrop handler
   // could never import anything. The webview's own drag-drop event carries
   // real filesystem paths instead.
   const [dropHasAudio, setDropHasAudio] = useState(true);

   const importPaths = useCallback(async (paths: string[]) => {
      const { audio, rejected } = partitionAudioPaths(paths);
      if (rejected.length > 0) {
         toast(
            audio.length === 0 ? "Nothing to import" : `Skipped ${rejected.length} file${rejected.length === 1 ? "" : "s"}`,
            `Only audio files can be imported (${AUDIO_EXTENSIONS.map((e) => e.toUpperCase()).join(", ")}).`,
            "info",
         );
      }
      const added = await importAudioFiles(audio);
      if (added.length > 1) toast(`Imported ${added.length} audio files`, undefined, "success");
   }, []);

   useEffect(() => {
      let disposed = false;
      let unlisten: (() => void) | undefined;
      try {
         getCurrentWebview()
            .onDragDropEvent((event) => {
               const p = event.payload;
               if (p.type === "enter") {
                  setDropHasAudio(partitionAudioPaths(p.paths).audio.length > 0);
                  setDragActive(true);
               } else if (p.type === "over") {
                  setDragActive(true);
               } else if (p.type === "leave") {
                  setDragActive(false);
               } else if (p.type === "drop") {
                  setDragActive(false);
                  void importPaths(p.paths);
               }
            })
            .then((fn) => {
               if (disposed) fn();
               else unlisten = fn;
            })
            .catch(() => undefined);
      } catch {
         /* not running inside Tauri (plain browser) — no native file drops */
      }
      return () => {
         disposed = true;
         unlisten?.();
         setDragActive(false);
      };
   }, [importPaths]);

   const handleImportAudio = async () => {
      let selected: string | string[] | null;
      try {
         selected = await open({ directory: false, multiple: true, filters: AUDIO_FILTERS });
      } catch (e) {
         toast("Couldn't open the file picker", errorMessage(e), "destructive");
         return;
      }
      if (!selected) return;
      const paths = (Array.isArray(selected) ? selected : [selected]).filter(
         (p): p is string => typeof p === "string",
      );
      await importAudioFiles(paths);
   };

   // Initialize with a new project if none exists
   useEffect(() => {
      if (!store.project) {
         store.newProject("Untitled Mix");
      }
   }, [store.project]);

   const hasSelection =
      store.selection.selectionStart !== null && store.selection.selectionEnd !== null;

   // Keyboard shortcuts for Studio
   useEffect(() => {
      const handleKeyDown = async (e: KeyboardEvent) => {
         // A modal owns the keyboard: Space/Delete must not drive the
         // transport or delete clips behind an open confirm dialog.
         if (useUiDialogStore.getState().request) return;
         // Skip if user is typing in an input
         if (
            e.target instanceof HTMLInputElement ||
            e.target instanceof HTMLTextAreaElement ||
            e.target instanceof HTMLSelectElement
         ) {
            return;
         }

         // Space: Play/Pause
         if (e.code === "Space") {
            e.preventDefault();
            if (store.playback.playing) {
               store.pause();
            } else {
               store.play();
            }
         }

         // Delete: remove selected timeline item, else selected library clip
         else if (e.key === "Delete" || e.key === "Backspace") {
            e.preventDefault();
            if (store.selection.selectedItemTrackId !== null && store.selection.selectedItemIndex !== null) {
               store.removeItem(store.selection.selectedItemTrackId, store.selection.selectedItemIndex);
            } else if (store.selection.selectedClipId) {
               if (await appConfirm("Delete this clip?")) {
                  store.deleteClip(store.selection.selectedClipId);
               }
            }
         }

         // S: Split the selected timeline item at the playhead
         else if (e.key === "s" && !e.ctrlKey && !e.metaKey && !e.altKey) {
            if (
               store.selection.selectedItemTrackId !== null &&
               store.selection.selectedItemIndex !== null
            ) {
               e.preventDefault();
               store.splitItem(
                  store.selection.selectedItemTrackId,
                  store.selection.selectedItemIndex,
                  store.playback.playhead,
               );
            }
         }

         // I / O: set the selection's in and out points at the playhead — the
         // classic editor idiom, and the fastest way to turn "that bit sounded
         // good" into a clip without aiming a drag.
         else if ((e.key === "i" || e.key === "o") && !e.ctrlKey && !e.metaKey && !e.altKey) {
            if (!store.selection.selectedSourceId) return;
            e.preventDefault();
            const t = store.playback.playhead;
            if (e.key === "i") {
               const end = store.selection.selectionEnd;
               store.setSelectionStart(t);
               if (end === null || end <= t) store.setSelectionEnd(t + 1);
            } else {
               const start = store.selection.selectionStart;
               if (start === null || start >= t) store.setSelectionStart(Math.max(0, t - 1));
               store.setSelectionEnd(t);
            }
         }

         // M: Add a marker at the current playhead
         else if (e.key === "m" && !e.ctrlKey && !e.metaKey && !e.altKey) {
            if (store.selection.selectedSourceId) {
               e.preventDefault();
               store.addMarker(store.selection.selectedSourceId, store.playback.playhead);
            }
         }

         // Ctrl/Cmd + Z: Undo
         else if ((e.ctrlKey || e.metaKey) && e.key === "z" && !e.shiftKey) {
            e.preventDefault();
            if (store.canUndo()) {
               store.undo();
            }
         }

         // Ctrl/Cmd + Shift + Z or Ctrl/Cmd + Y: Redo
         else if (
            ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === "z") ||
            ((e.ctrlKey || e.metaKey) && e.key === "y")
         ) {
            e.preventDefault();
            if (store.canRedo()) {
               store.redo();
            }
         }

         // Ctrl/Cmd + S: Save project
         else if ((e.ctrlKey || e.metaKey) && e.key === "s") {
            e.preventDefault();
            if (store.savedPath) {
               handleSaveProject();
            } else {
               handleSaveProjectAs();
            }
         }

         // Ctrl/Cmd + E: Export
         else if ((e.ctrlKey || e.metaKey) && e.key === "e") {
            e.preventDefault();
            setShowExportDialog(true);
         }

         // Ctrl/Cmd + N: New project
         else if ((e.ctrlKey || e.metaKey) && e.key === "n") {
            e.preventDefault();
            handleNewProject();
         }

         // Ctrl/Cmd + O: Open project
         else if ((e.ctrlKey || e.metaKey) && e.key === "o") {
            e.preventDefault();
            handleOpenProject();
         }

         // Ctrl/Cmd + D: Duplicate — the selected timeline item if there is
         // one (the thing actually on screen under the cursor), else the
         // selected library clip.
         else if ((e.ctrlKey || e.metaKey) && e.key === "d") {
            e.preventDefault();
            if (store.selection.selectedItemTrackId !== null && store.selection.selectedItemIndex !== null) {
               store.duplicateItem(store.selection.selectedItemTrackId, store.selection.selectedItemIndex);
            } else if (store.selection.selectedClipId) {
               store.duplicateClip(store.selection.selectedClipId);
            }
         }

         // Home: Jump to start
         else if (e.key === "Home") {
            e.preventDefault();
            store.seek(0);
         }

         // End: Jump to end (based on current mode duration)
         else if (e.key === "End") {
            e.preventDefault();
            const duration = store.playback.mode === "source" && store.selection.selectedSourceWaveform
               ? store.selection.selectedSourceWaveform.duration
               : store.project ? computeCompositionStats(store.project).duration : 0;
            store.seek(duration);
         }
      };

      window.addEventListener("keydown", handleKeyDown);
      return () => window.removeEventListener("keydown", handleKeyDown);
   }, [
      store,
      handleSaveProject,
      handleSaveProjectAs,
      handleNewProject,
      handleOpenProject,
   ]);

   if (!store.project) {
      return (
         <div className="studio-shell flex h-full items-center justify-center bg-studio-bg text-studio-text-muted text-sm">
            Loading studio…
         </div>
      );
   }

   if (store.project.sources.length === 0) {
      return (
         <div
            className={`studio-shell relative flex flex-col items-center justify-center h-full gap-5 bg-studio-bg text-studio-text p-8 text-center transition-colors ${
               dragActive ? "bg-studio-accent/10" : ""
            }`}
         >
            <div
               className={`absolute inset-6 rounded-2xl border-2 border-dashed pointer-events-none transition-colors ${
                  dragActive ? (dropHasAudio ? "border-studio-accent" : "border-studio-danger") : "border-transparent"
               }`}
            />
            <img src="/logo.png" alt="Amen" className="w-16 h-16 mb-2 drop-shadow-xl opacity-95 animate-scale-in" />
            <h2 className="text-2xl font-semibold tracking-tight">Create something new.</h2>
            <p className="text-studio-text-muted text-[15px] max-w-sm leading-relaxed">
               Bring in an audio file and start shaping the moment — import a
               source, select the part that matters, and build it into a mix.
            </p>
            <div className="flex gap-3 mt-2">
               <button
                  onClick={handleImportAudio}
                  className="bg-studio-accent hover:brightness-110 text-white px-5 py-2.5 rounded-lg font-medium transition shadow-lg shadow-studio-accent/25 flex items-center gap-2"
               >
                  <FilePlus size={18} />
                  Import Audio
               </button>
               <button
                  onClick={handleOpenProject}
                  className="bg-studio-panel hover:bg-studio-raised border border-studio-border text-studio-text px-5 py-2.5 rounded-lg font-medium transition flex items-center gap-2"
               >
                  <FolderOpen size={18} />
                  Open Project
               </button>
            </div>
            <p className={`text-xs mt-6 ${dragActive && !dropHasAudio ? "text-studio-danger" : "text-studio-text-faint"}`}>
               {dragActive
                  ? dropHasAudio
                     ? "Drop audio files here"
                     : "Only audio files can be imported"
                  : "or drag audio files here"}
            </p>
         </div>
      );
   }

   // Single authoritative composition figure (mirrors the Rust renderer's
   // `project.duration()` exactly, so the UI never disagrees with the file
   // that gets written).
   const stats = computeCompositionStats(store.project);
   const projectDuration = stats.duration;
   const deadAir = stats.leadingSilence + stats.gapSilence;
   // Worth pointing out only when it is a real share of the mix, not a
   // rounding artefact of a deliberate breath between clips.
   const showDeadAirWarning = projectDuration > 0 && deadAir > 1 && deadAir / projectDuration > 0.08;

   const currentSource = store.selection.selectedSourceId
      ? store.project.sources.find(s => s.id === store.selection.selectedSourceId)
      : undefined;
   const waveformError = store.waveformError;
   const effectiveDuration = store.playback.mode === "source" && store.selection.selectedSourceId
      ? (currentSource?.duration || projectDuration)
      : projectDuration;

   // What is the transport actually about to play? Source playback, a clip
   // preview, and the rendered timeline mix all use the same <audio> element
   // underneath — the user must never have to guess which one is live.
   const nowPlaying: { kind: "source" | "clip" | "timeline"; label: string } =
      store.playback.mode === "timeline"
         ? { kind: "timeline", label: "Timeline Mix" }
         : store.playback.previewingClipId && store.playback.previewingClipId !== "__selection__"
         ? { kind: "clip", label: store.project.clips.find((c) => c.id === store.playback.previewingClipId)?.name ?? "Clip" }
         : store.playback.previewingClipId === "__selection__"
         ? { kind: "clip", label: "selection" }
         : { kind: "source", label: store.project.sources.find((s) => s.id === store.selection.selectedSourceId)?.name ?? "source" };

   const hasTimelineContent = store.project.timeline.tracks.some((t) => t.items.length > 0);

   return (
      <div
         className="studio-shell relative flex flex-col h-full gap-2.5 p-2.5 bg-studio-bg text-studio-text overflow-hidden"
      >
         {dragActive && (
            <div
               data-testid="studio-drop-overlay"
               className={`absolute inset-0 z-50 flex items-center justify-center bg-studio-bg/90 backdrop-blur-sm border-4 border-dashed pointer-events-none rounded-xl ${
                  dropHasAudio ? "border-studio-accent" : "border-studio-danger"
               }`}
            >
               <div className="text-center">
                  <FilePlus size={56} className={`mx-auto mb-3 ${dropHasAudio ? "text-studio-accent" : "text-studio-danger"}`} />
                  <p className="text-xl font-semibold text-studio-text">
                     {dropHasAudio ? "Drop audio files to import" : "Only audio files can be imported"}
                  </p>
                  <p className="text-studio-text-muted mt-1 text-sm">
                     {AUDIO_EXTENSIONS.map((e) => e.toUpperCase()).join(", ")}
                  </p>
               </div>
            </div>
         )}

         {/* Toolbar */}
         <div className="flex items-center justify-between gap-4 flex-wrap bg-studio-panel rounded-xl px-3.5 py-2.5 border border-studio-border shrink-0">
            <div className="flex items-center gap-2.5 min-w-0">
               <img src="/logo.png" alt="" className="w-6 h-6 rounded-md shrink-0 opacity-95" />
               <div className="min-w-0">
                  {renamingTitle ? (
                     <input
                        autoFocus
                        data-testid="studio-title-input"
                        defaultValue={store.project.name}
                        onFocus={(e) => e.currentTarget.select()}
                        onBlur={(e) => commitTitle(e.currentTarget.value)}
                        onKeyDown={(e) => {
                           if (e.key === "Enter") {
                              e.preventDefault();
                              commitTitle(e.currentTarget.value);
                           } else if (e.key === "Escape") {
                              e.preventDefault();
                              setRenamingTitle(false);
                           }
                        }}
                        className="w-56 max-w-full bg-studio-canvas border border-studio-accent/60 rounded-md px-1.5 py-0.5 text-[14px] font-semibold tracking-tight text-studio-text outline-none"
                     />
                  ) : (
                     <h1
                        data-testid="studio-title"
                        onDoubleClick={() => setRenamingTitle(true)}
                        title="Double-click to rename this mix"
                        className="text-[14px] font-semibold tracking-tight text-studio-text flex items-center gap-1.5 truncate cursor-text hover:text-studio-accent-strong transition"
                     >
                        {store.project.name}
                        {store.modified && (
                           <span className="text-studio-snap text-[10px]" title="Unsaved changes">●</span>
                        )}
                     </h1>
                  )}
                  {store.savedPath && (
                     <span className="text-[10px] text-studio-text-faint font-mono truncate block max-w-xs" title={store.savedPath}>
                        {store.savedPath.split(/[\\/]/).pop()}
                     </span>
                  )}
               </div>
            </div>

            {/* The one number that answers "what am I about to export?" */}
            <div
               data-testid="composition-summary"
               data-composition-duration={projectDuration}
               className="flex items-center gap-2 text-[11px] text-studio-text-muted tabular-nums"
            >
               <span className="text-studio-text-faint uppercase tracking-wide">Mix</span>
               <span className="text-studio-text font-mono text-[13px]">{formatClock(projectDuration)}</span>
               <span className="text-studio-text-faint">
                  {stats.itemCount} clip{stats.itemCount === 1 ? "" : "s"}
               </span>
               {showDeadAirWarning && (
                  <span
                     data-testid="dead-air-warning"
                     className="flex items-center gap-1 rounded-md bg-studio-snap/15 text-studio-snap px-2 py-0.5"
                     title="Silence in the arrangement is exported too. Use Close gaps on the timeline to remove it."
                  >
                     <AlertTriangle size={11} />
                     {formatDuration(deadAir)} silence
                  </span>
               )}
            </div>

            <div className="flex items-center gap-1.5 ml-auto">
               <button
                  onClick={handleNewProject}
                  className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 hover:bg-studio-raised transition text-[12px] text-studio-text-muted hover:text-studio-text"
                  title="New project (Ctrl+N)"
               >
                  <Plus size={14} />
                  New
               </button>
               <button
                  onClick={handleOpenProject}
                  className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 hover:bg-studio-raised transition text-[12px] text-studio-text-muted hover:text-studio-text"
                  title="Open project (Ctrl+O)"
               >
                  <FolderOpen size={14} />
                  Open
               </button>
               <button
                  onClick={handleSaveProject}
                  data-testid="studio-save"
                  className="flex items-center gap-1.5 rounded-lg bg-studio-accent px-3 py-1.5 hover:brightness-110 transition disabled:opacity-50 text-[12px] font-medium text-white shadow-sm shadow-studio-accent/30"
                  disabled={saving || store.loadingState === "saving"}
                  title={store.savedPath ? "Save project (Ctrl+S)" : "Choose where to save (Ctrl+S)"}
               >
                  {saving ? (
                     <Loader2 size={14} className="animate-spin" />
                  ) : (
                     <Save size={14} />
                  )}
                  {saving ? "Saving…" : "Save"}
                  {!saving && store.modified && (
                     // Unsaved-changes marker as a dot, not a "*" in the label:
                     // the label is this button's accessible name, and mutating
                     // it renames the control for screen readers (and for
                     // anything that looks a button up by name).
                     <span
                        aria-hidden="true"
                        title="Unsaved changes"
                        className="h-1.5 w-1.5 rounded-full bg-white/80"
                     />
                  )}
               </button>

               <div className="w-px h-5 bg-studio-border mx-0.5" />

               <button
                  onClick={() => store.undo()}
                  disabled={!store.canUndo()}
                  className="rounded-lg p-1.5 hover:bg-studio-raised disabled:opacity-30 disabled:hover:bg-transparent transition text-studio-text-muted hover:text-studio-text"
                  title="Undo (Ctrl+Z)"
               >
                  <RotateCcw size={14} />
               </button>
               <button
                  onClick={() => store.redo()}
                  disabled={!store.canRedo()}
                  className="rounded-lg p-1.5 hover:bg-studio-raised disabled:opacity-30 disabled:hover:bg-transparent transition text-studio-text-muted hover:text-studio-text"
                  title="Redo (Ctrl+Shift+Z)"
               >
                  <RotateCw size={14} />
               </button>

               <div className="w-px h-5 bg-studio-border mx-0.5" />

               <button
                  onClick={() => setShowExportDialog(true)}
                  className="flex items-center gap-1.5 rounded-lg bg-studio-success/90 px-3 py-1.5 hover:brightness-110 transition disabled:opacity-50 text-[12px] font-semibold text-black/80 shadow-sm shadow-studio-success/20"
                  disabled={exporting}
                  title="Export mix (Ctrl+E)"
               >
                  Export
               </button>
            </div>
         </div>

         {/* Main workspace */}
         <div className="flex gap-2.5 flex-1 min-h-0 overflow-hidden">
            {/* Left rail: sources & clip library. Narrower on small windows so
                the timeline keeps the space that matters. */}
            <div className="w-56 xl:w-64 shrink-0 flex flex-col gap-2.5 min-h-0">
               <div className="bg-studio-panel rounded-xl p-3 border border-studio-border shrink-0">
                  <SourcePanel
                     sources={store.project.sources}
                     selectedSourceId={store.selection.selectedSourceId}
                     onAddSource={async (path) => {
                        await importAudioFiles([path]);
                     }}
                     onRemoveSource={async (id) => {
                        const affectedClips = store.project?.clips.filter((c) => c.sourceId === id).length ?? 0;
                        const message = affectedClips > 0
                           ? `Remove this source? ${affectedClips} clip${affectedClips === 1 ? "" : "s"} made from it — and any timeline placements of ${affectedClips === 1 ? "it" : "them"} — will be deleted too.`
                           : "Remove this source?";
                        if (await appConfirm(message)) {
                           store.removeSource(id);
                        }
                     }}
                     onSelectSource={(id) => store.selectSource(id)}
                  />
               </div>

               <div className="bg-studio-panel rounded-xl p-3 border border-studio-border flex-1 min-h-0">
                  <ClipLibrary
                     clips={store.project.clips}
                     sources={store.project.sources}
                     selectedClipId={store.selection.selectedClipId}
                     previewingClipId={store.playback.previewingClipId}
                     canCreateClip={hasSelection}
                     onCreateClipFromSelection={() =>
                        store.createClipFromSelection()
                     }
                     onSelectClip={(id) => store.setSelectedClip(id)}
                     onPreviewClip={(id) => store.previewClip(id)}
                     onRenameClip={(id, name) => store.renameClip(id, name)}
                     onDeleteClip={(id) => store.deleteClip(id)}
                     onDuplicateClip={(id) => store.duplicateClip(id)}
                     onAppendClip={appendClip}
                     draggingClipId={dragClip?.clipId ?? null}
                     onBeginDrag={(clipId, x, y) => {
                        const clip = store.project?.clips.find((c) => c.id === clipId);
                        setDragCandidate({ clipId, name: clip?.name ?? "Clip", x, y });
                     }}
                  />
               </div>
            </div>

            {/* Center: source editor (top) + resizable timeline (bottom) */}
            <div ref={centerColumnRef} className="flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden gap-2.5">
               {/* Source editor pane. `min-w-0` at every level and wrapping
                   control rows — a fixed-width control row inside a flex child
                   is what used to push the whole column into horizontal
                   overflow and clip the waveform off the left edge. The
                   waveform itself FLEXES rather than the pane scrolling, so
                   the one surface you have to be able to see and aim at is
                   never the thing that gets pushed off screen. */}
               <div
                  data-testid="source-editor-pane"
                  className="flex-1 min-h-0 min-w-0 flex flex-col gap-2.5 overflow-y-auto overflow-x-hidden"
               >
                  {store.selection.selectedSourceWaveform ? (
                     <>
                        <WaveformView
                           key={store.selection.selectedSourceId}
                           waveform={store.selection.selectedSourceWaveform}
                           duration={store.selection.selectedSourceWaveform.duration}
                           selectionStart={store.selection.selectionStart}
                           selectionEnd={store.selection.selectionEnd}
                           onSelectionChange={(start, end) => {
                              store.setSelectionStart(start);
                              store.setSelectionEnd(end);
                           }}
                           onSeek={(time) => store.seek(time)}
                           playhead={store.playback.playhead}
                           playing={store.playback.playing && store.playback.mode === "source"}
                           markers={currentSource?.markers}
                        />

                        {/* Markers — cue-point style bookmarks for navigating this source */}
                        <div className="flex items-center gap-2 bg-studio-panel px-3 py-2 rounded-xl border border-studio-border min-w-0 shrink-0 overflow-x-auto">
                           <button
                              onClick={() => currentSource && store.addMarker(currentSource.id, store.playback.playhead)}
                              className="flex items-center gap-1.5 rounded-md bg-studio-raised hover:bg-white/10 border border-studio-border px-2.5 py-1 text-[11px] font-medium text-studio-text transition shrink-0"
                              title="Add a marker at the current playhead (M)"
                           >
                              <Flag size={12} />
                              Add Marker
                           </button>
                           {currentSource && currentSource.markers.length > 0 ? (
                              currentSource.markers.map((m, mi) => {
                                 const next = currentSource.markers[mi + 1];
                                 return (
                                    <div
                                       key={m.id}
                                       data-testid="waveform-marker"
                                       className="group flex items-center gap-1 rounded-md bg-studio-canvas border border-studio-border pl-2 pr-1 py-1 text-[11px] text-studio-text shrink-0"
                                    >
                                       <button
                                          onClick={() => store.seek(m.time)}
                                          className="flex items-center gap-1.5 hover:text-studio-accent-strong transition"
                                          title={`Jump to ${m.label}`}
                                       >
                                          <span className="h-1.5 w-1.5 rounded-full bg-[#ffb454] shrink-0" />
                                          <span className="font-mono tabular-nums">{formatTime(m.time)}</span>
                                          <span className="text-studio-text-muted">{m.label}</span>
                                       </button>
                                       {/* Marker -> selection: the point of bookmarking a
                                           moment is to cut a clip from it a minute later. */}
                                       <button
                                          onClick={() => {
                                             const end = next
                                                ? next.time
                                                : Math.min(currentSource.duration, m.time + 30);
                                             if (end <= m.time) return;
                                             store.setSelectionStart(m.time);
                                             store.setSelectionEnd(end);
                                             store.seek(m.time);
                                          }}
                                          data-testid="marker-to-selection"
                                          className="p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-studio-accent/20 hover:text-studio-accent-strong transition"
                                          title={next ? "Select from here to the next marker" : "Select 30s from here"}
                                       >
                                          <CornerDownRight size={10} />
                                       </button>
                                       <button
                                          onClick={() => currentSource && store.removeMarker(currentSource.id, m.id)}
                                          className="p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-studio-danger/15 hover:text-studio-danger transition"
                                          title="Remove marker"
                                       >
                                          <X size={10} />
                                       </button>
                                    </div>
                                 );
                              })
                           ) : (
                              <span className="text-[11px] text-studio-text-faint">No markers yet — bookmark positions as you listen (M)</span>
                           )}
                        </div>

                        {/* Selection controls — ALWAYS mounted, never conditional.
                            Mounting this panel only once a selection existed made
                            the flex column steal height from the waveform at the
                            exact moment the user was dragging across it: the canvas
                            resized mid-gesture and the drag stopped tracking, so the
                            very first selection on any source came out a fraction of
                            its intended length. Reserving the space costs nothing and
                            has the happy side effect that Start/End/Preview/Create
                            Clip are visible before you need them, instead of
                            appearing only after you have already guessed correctly. */}
                        <div
                           data-testid="selection-controls"
                           aria-disabled={!hasSelection}
                           className={`flex items-end gap-3 flex-wrap bg-studio-panel p-3 rounded-xl border border-studio-border min-w-0 shrink-0 transition-opacity ${
                              hasSelection ? "" : "opacity-45"
                           }`}
                        >
                              <TimeInput
                                 label="Start"
                                 className="w-32 shrink-0"
                                 value={store.selection.selectionStart}
                                 onChange={(val) => {
                                    const end = store.selection.selectionEnd ?? val + 1;
                                    store.setSelectionStart(Math.min(val, end - 0.001));
                                 }}
                                 min={0}
                                 max={store.selection.selectedSourceWaveform.duration}
                              />
                              <TimeInput
                                 label="End"
                                 className="w-32 shrink-0"
                                 value={store.selection.selectionEnd}
                                 onChange={(val) => {
                                    const start = store.selection.selectionStart ?? 0;
                                    store.setSelectionEnd(Math.max(val, start + 0.001));
                                 }}
                                 min={0}
                                 max={store.selection.selectedSourceWaveform.duration}
                              />
                              <div className="flex flex-col gap-1 shrink-0">
                                 <label className="text-[11px] text-studio-text-muted font-medium">Duration</label>
                                 <div
                                    data-testid="selection-duration"
                                    className="px-3 py-1.5 bg-studio-canvas border border-studio-border rounded-md text-sm font-mono text-studio-text tabular-nums w-28"
                                 >
                                    {hasSelection
                                       ? formatTime(store.selection.selectionEnd! - store.selection.selectionStart!)
                                       : formatTime(0)}
                                 </div>
                              </div>

                              <div className="flex gap-2 flex-wrap ml-auto">
                                 <button
                                    onClick={() => store.previewSelection()}
                                    data-testid="preview-selection"
                                    disabled={!hasSelection}
                                    className="flex items-center gap-2 bg-studio-raised hover:bg-white/10 border border-studio-border px-3 py-2 rounded-lg font-medium transition text-[13px] text-studio-text disabled:opacity-40 disabled:hover:bg-studio-raised"
                                    title={hasSelection ? "Play only the selected region" : "Drag across the waveform to select a region first"}
                                 >
                                    <Play size={14} />
                                    Preview
                                 </button>
                                 <button
                                    onClick={() => store.toggleLoop()}
                                    data-testid="loop-toggle"
                                    disabled={!hasSelection}
                                    aria-pressed={store.playback.looping}
                                    className={`flex items-center gap-2 border px-3 py-2 rounded-lg font-medium transition text-[13px] ${
                                       store.playback.looping
                                          ? "bg-studio-snap/20 border-studio-snap/50 text-studio-snap"
                                          : "bg-studio-raised hover:bg-white/10 border-studio-border text-studio-text"
                                    } disabled:opacity-40`}
                                    title="Loop the current selection during playback"
                                 >
                                    <Repeat size={14} />
                                    Loop
                                 </button>
                                 <button
                                    onClick={() => store.createClipFromSelection()}
                                    data-testid="create-clip"
                                    disabled={!hasSelection}
                                    title={hasSelection ? "Create a clip from the selected region" : "Drag across the waveform to select a region first"}
                                    className="flex items-center gap-2 bg-studio-accent hover:brightness-110 px-3.5 py-2 rounded-lg font-medium transition text-[13px] text-white shadow-sm shadow-studio-accent/30 disabled:opacity-40 disabled:hover:brightness-100"
                                 >
                                    <Plus size={16} />
                                    Create Clip
                                 </button>
                              </div>
                        </div>
                     </>
                  ) : waveformError && waveformError.sourceId === store.selection.selectedSourceId ? (
                     <div
                        data-testid="waveform-error"
                        className="flex-1 flex flex-col items-center justify-center gap-3 text-center bg-studio-panel rounded-xl border border-studio-danger/30 p-6"
                     >
                        <AlertTriangle size={22} className="text-studio-danger" />
                        <div>
                           <p className="text-[13px] font-medium text-studio-text">
                              Couldn't load the waveform for {currentSource?.name ?? "this source"}
                           </p>
                           <p className="mt-1 max-w-md text-[12px] text-studio-text-muted break-words">
                              {waveformError.message}
                           </p>
                        </div>
                        <button
                           onClick={() => store.getSourceWaveform(waveformError.sourceId)}
                           className="flex items-center gap-1.5 rounded-lg bg-studio-raised hover:bg-white/10 border border-studio-border px-3 py-1.5 text-[12px] font-medium text-studio-text transition"
                        >
                           <RotateCw size={13} />
                           Retry
                        </button>
                     </div>
                  ) : store.selection.selectedSourceId &&
                    store.waveformLoadingId === store.selection.selectedSourceId ? (
                     <div className="flex-1 flex items-center justify-center gap-2 text-[13px] text-studio-text-muted bg-studio-panel rounded-xl border border-studio-border p-6">
                        <Loader2 size={15} className="animate-spin" />
                        Reading the waveform…
                     </div>
                  ) : (
                     <div className="flex-1 flex items-center justify-center text-center text-[13px] text-studio-text-faint bg-studio-panel rounded-xl border border-studio-border p-6">
                        Pick a source on the left to see its waveform, then drag
                        across it to select the part you want.
                     </div>
                  )}
               </div>

               {/* Transport / player bar — always visible, never scrolled away */}
               <div className="space-y-2.5 shrink-0 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap text-[12px] bg-studio-panel px-3.5 py-2 rounded-xl border border-studio-border min-w-0">
                     <span className="text-studio-text-muted font-medium shrink-0">Playback:</span>
                     <button
                        onClick={() => store.playFullSource()}
                        data-testid="playback-mode-source"
                        className={`px-2.5 py-1 rounded-md font-medium transition shrink-0 ${
                           store.playback.mode === "source" && !store.playback.previewingClipId
                              ? "bg-studio-accent text-white shadow-sm"
                              : "bg-studio-raised text-studio-text-muted hover:text-studio-text"
                        }`}
                        disabled={!store.selection.selectedSourceId}
                        title="Play the whole source file, ignoring any selection"
                     >
                        Source
                     </button>
                     <button
                        onClick={async () => {
                           if (hasTimelineContent) {
                              await store.renderPreview();
                           }
                        }}
                        data-testid="playback-mode-timeline"
                        className={`px-2.5 py-1 rounded-md font-medium transition shrink-0 ${
                           store.playback.mode === "timeline"
                              ? "bg-studio-accent text-white shadow-sm"
                              : "bg-studio-raised text-studio-text-muted hover:text-studio-text"
                        }`}
                        disabled={!hasTimelineContent}
                        title="Play the rendered timeline composition"
                     >
                        Timeline Mix
                        {store.previewRendering ? (
                           <Loader2 size={11} className="ml-1 inline animate-spin" />
                        ) : (
                           store.playback.previewStale && store.playback.mode === "timeline" && (
                              <span className="ml-1 text-studio-snap animate-pulse">●</span>
                           )
                        )}
                     </button>

                     {/* Unambiguous "what am I about to hear" indicator — source
                         playback, a clip preview, and the timeline mix all drive
                         the same <audio> element, so the label (not a guess) is
                         the only thing that tells them apart. */}
                     <div
                        data-testid="now-playing-indicator"
                        data-now-playing-kind={nowPlaying.kind}
                        className={`ml-auto flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-medium max-w-55 min-w-0 ${
                           nowPlaying.kind === "timeline"
                              ? "bg-studio-success/15 text-studio-success"
                              : nowPlaying.kind === "clip"
                              ? "bg-studio-snap/15 text-studio-snap"
                              : "bg-studio-accent/15 text-studio-accent-strong"
                        }`}
                     >
                        {store.playback.playing ? <Play size={11} className="shrink-0" /> : <span className="w-2.75 shrink-0" />}
                        <span className="uppercase tracking-wide shrink-0">
                           {nowPlaying.kind === "timeline" ? "Timeline Mix" : nowPlaying.kind === "clip" ? "Clip Preview" : "Source"}
                        </span>
                        {nowPlaying.kind !== "timeline" && (
                           <span className="truncate opacity-80" title={nowPlaying.label}>
                              · {nowPlaying.label}
                           </span>
                        )}
                     </div>

                     {store.playback.mode === "timeline" && store.playback.previewStale && (
                        <button
                           onClick={() => store.renderPreview()}
                           disabled={store.previewRendering}
                           className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-studio-snap/20 hover:bg-studio-snap/30 text-studio-snap text-[11px] font-medium transition shrink-0 disabled:opacity-60"
                        >
                           {store.previewRendering && <Loader2 size={11} className="animate-spin" />}
                           {store.previewRendering ? "Rendering…" : "Update Preview"}
                        </button>
                     )}
                  </div>

                  <PlayerBar
                     playing={store.playback.playing}
                     playhead={store.playback.playhead}
                     duration={effectiveDuration || 30}
                     volume={store.playback.volume}
                     muted={store.playback.muted}
                     playbackRate={store.playback.playbackRate}
                     onPlay={() => store.play()}
                     onPause={() => store.pause()}
                     onStop={() => store.stop()}
                     onSeek={(t) => store.seek(t)}
                     onVolumeChange={(v) => store.setVolume(v)}
                     onMuteToggle={() => store.setMuted(!store.playback.muted)}
                     onPlaybackRateChange={(r) => store.setPlaybackRate(r)}
                     previewPath={store.playback.previewPath}
                     mode={store.playback.mode}
                     sourcePlaybackPath={store.playback.sourcePlaybackPath}
                     previewStart={store.playback.mode === "source" ? store.playback.previewStart : null}
                     previewEnd={store.playback.mode === "source" ? store.playback.previewEnd : null}
                     looping={store.playback.looping}
                  />
               </div>

               {/* Resize handle */}
               <div
                  onPointerDown={(e) => {
                     e.preventDefault();
                     beginTimelineResize(e.clientY, timelineHeight);
                  }}
                  className="group relative flex items-center justify-center h-3 shrink-0 cursor-row-resize touch-none"
                  title="Drag to resize the timeline"
                  data-testid="timeline-resize-handle"
               >
                  <div className="w-10 h-1 rounded-full bg-studio-border group-hover:bg-studio-accent transition-colors" />
                  <GripHorizontal size={12} className="absolute text-studio-text-faint opacity-0 group-hover:opacity-60 transition" />
               </div>

               {/* Timeline — THE CREATIVE WORKSPACE */}
               <div
                  className="shrink-0 overflow-hidden bg-studio-panel rounded-xl border border-studio-border p-2.5"
                  style={{ height: timelineHeight }}
               >
                  <Timeline
                     key={store.project.createdAt}
                     tracks={store.project.timeline.tracks}
                     clips={store.project.clips}
                     duration={projectDuration}
                     selectedTrackId={store.selection.selectedTrackId}
                     selectedItemTrackId={store.selection.selectedItemTrackId}
                     selectedItemIndex={store.selection.selectedItemIndex}
                     onMoveItem={(trackId, idx, newPos, recordHistory) =>
                        store.moveItem(trackId, idx, newPos, recordHistory)
                     }
                     onMoveItemToTrack={(fromTrackId, idx, toTrackId, newPos, recordHistory) =>
                        store.moveItemToTrack(fromTrackId, idx, toTrackId, newPos, recordHistory)
                     }
                     onCommitItemOrder={(trackId, idx) => store.commitItemOrder(trackId, idx)}
                     onBeginItemEdit={() => store.checkpointHistory()}
                     onSplitItem={(trackId, idx, atTime) => store.splitItem(trackId, idx, atTime)}
                     onRemoveItem={(trackId, idx) => store.removeItem(trackId, idx)}
                     onDuplicateItem={(trackId, idx) => store.duplicateItem(trackId, idx)}
                     onSelectItem={(trackId, idx) => {
                        store.setSelectedTrack(trackId);
                        store.setSelectedItem(trackId, idx);
                     }}
                     onSelectTrack={(trackId) => {
                        store.setSelectedTrack(trackId);
                        store.setSelectedItem(null, null);
                     }}
                     onAddTrack={() => store.addTrack()}
                     onRemoveTrack={(id) => store.removeTrack(id)}
                     onUpdateItem={(trackId, idx, updates, recordHistory) =>
                        store.updateItem(trackId, idx, updates, recordHistory)
                     }
                     onToggleMute={(trackId, muted) => store.setTrackMute(trackId, muted)}
                     onToggleSolo={(trackId, solo) => store.setTrackSolo(trackId, solo)}
                     onTrackVolume={(trackId, v) => store.setTrackVolume(trackId, v)}
                     onCloseGaps={(trackId) => store.closeGaps(trackId)}
                     playhead={store.playback.playhead}
                     onSeek={(t) => store.seek(t)}
                     playing={store.playback.playing && store.playback.mode === "timeline"}
                     externalDrag={
                        dragClip
                           ? { clipId: dragClip.clipId, name: dragClip.name, clientX: dragClip.x, clientY: dragClip.y }
                           : null
                     }
                     onExternalHoverChange={(hover) => {
                        dragHoverRef.current = hover;
                     }}
                  />
               </div>
            </div>
         </div>

         {/* Export dialog */}
         <ExportDialog
            open={showExportDialog}
            onClose={() => setShowExportDialog(false)}
            onExport={handleExportMix}
            isLoading={exporting}
            durationSeconds={projectDuration}
         />

         {/* Floating ghost for the pointer-based clip drag (library -> timeline) */}
         {dragClip && (
            <div
               data-testid="clip-drag-ghost"
               style={{ left: dragClip.x + 12, top: dragClip.y + 12 }}
               className="fixed z-100 pointer-events-none px-3 py-1.5 rounded-md bg-studio-accent text-white text-xs font-medium shadow-xl shadow-black/40 border border-white/20"
            >
               {dragClip.name}
            </div>
         )}
      </div>
   );
}
