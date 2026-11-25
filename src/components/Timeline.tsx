import { useRef, useState, useEffect, useCallback, useMemo, useLayoutEffect } from "react";
import { playClock, precisePlayhead } from "@/lib/playClock";
import { Trash2, Plus, Edit2, Copy, Volume2, VolumeX, Scissors, Magnet, AlignHorizontalJustifyStart } from "lucide-react";
import type { StudioTrack, StudioTimelineItem, StudioClip } from "../lib/studioTypes";
import { itemEffectiveDuration } from "../lib/studioTypes";
import { formatTime, formatDuration, formatClock } from "../lib/studioTime";
import {
   createTimeAxis,
   buildRuler,
   clampZoom,
   fitZoom,
   initialZoom,
   MIN_PX_PER_SECOND,
   MAX_PX_PER_SECOND,
} from "../lib/timeAxis";
import { colorForSource } from "../lib/studioColors";
import { ClipEditDialog } from "./ClipEditDialog";
import { appConfirm } from "../stores/uiDialog";

const MIN_ITEM_DURATION = 0.1; // seconds — floor so trim can never invert a clip
const HEADER_WIDTH = 184; // fixed track-header column width (never scrolls away)
const TRACK_HEIGHT = 96;
const RULER_HEIGHT = 30;
/**
 * Snap radius in POINTER pixels, not seconds — so it feels the same at every
 * zoom level, which is the whole point of magnetic editing. 14px is roughly
 * "the clip edge I was aiming at" without hijacking a deliberate small offset.
 */
const SNAP_PX = 14;
/** Extra empty time kept to the right of the last clip, so there is always somewhere to drop. */
const TAIL_PAD_SECONDS = 30;
/** How long auto-follow stays out of the way after the user scrolls/zooms by hand. */
const FOLLOW_SUSPEND_MS = 2500;

export interface ExternalClipDrag {
   clipId: string;
   name: string;
   clientX: number;
   clientY: number;
}

export interface DropHover {
   trackId: string;
   position: number;
   snapped: boolean;
}

interface TimelineProps {
   tracks: StudioTrack[];
   clips: StudioClip[];
   /** Composition duration — the exported length, and what Fit fits. */
   duration: number;
   selectedTrackId?: string | null;
   selectedItemTrackId?: string | null;
   selectedItemIndex?: number | null;
   onMoveItem?: (trackId: string, index: number, newPosition: number, recordHistory?: boolean) => void;
   onMoveItemToTrack?: (
      fromTrackId: string,
      index: number,
      toTrackId: string,
      newPosition: number,
      recordHistory?: boolean,
   ) => number | null;
   /** Restore the sorted-by-position invariant once a move gesture ends. */
   onCommitItemOrder?: (trackId: string, index: number) => number;
   onRemoveItem?: (trackId: string, index: number) => void;
   onDuplicateItem?: (trackId: string, index: number) => void;
   onSelectItem?: (trackId: string, index: number) => void;
   onSelectTrack?: (trackId: string) => void;
   onAddTrack?: () => void;
   onRemoveTrack?: (trackId: string) => void;
   onUpdateItem?: (trackId: string, index: number, updates: Partial<StudioTimelineItem>, recordHistory?: boolean) => void;
   /** Called once at the start of a move/trim drag gesture, before any live update — lets the store snapshot undo history exactly once per gesture instead of once per pointermove. */
   onBeginItemEdit?: () => void;
   /** Split the selected timeline item into two at the given absolute timeline position. */
   onSplitItem?: (trackId: string, index: number, atTime: number) => void;
   onToggleMute?: (trackId: string, muted: boolean) => void;
   onToggleSolo?: (trackId: string, solo: boolean) => void;
   onTrackVolume?: (trackId: string, volume: number) => void;
   /** Pull a track's clips together so they play back-to-back with no dead air. */
   onCloseGaps?: (trackId: string) => void;
   playhead?: number;
   /** Move the playhead — the ruler is a scrub surface, like every real editor. */
   onSeek?: (time: number) => void;
   /** True while the transport is running: enables playhead auto-follow. */
   playing?: boolean;
   /** A clip being dragged in from the library via pointer events (not native HTML5 DnD). */
   externalDrag?: ExternalClipDrag | null;
   /** Called whenever the hovered drop target changes while `externalDrag` is active. */
   onExternalHoverChange?: (hover: DropHover | null) => void;
}

/** Snap `time` to the nearest candidate within `thresholdTime`, else return it unchanged. */
function applySnap(time: number, candidates: number[], thresholdTime: number): { value: number; snapped: boolean } {
   let best = time;
   let bestDist = thresholdTime;
   let snapped = false;
   for (const c of candidates) {
      const d = Math.abs(c - time);
      if (d <= bestDist) {
         bestDist = d;
         best = c;
         snapped = true;
      }
   }
   return { value: best, snapped };
}

/**
 * The Studio's arrangement workspace.
 *
 * Design notes that matter for correctness, not just looks:
 * - ONE zoom model, shared with the waveform via `src/lib/timeAxis.ts`. Every
 *   zoom action routes through `clampZoom`, so no gesture can strand the view
 *   at a scale it cannot recover from, and Fit always genuinely fits.
 * - The ruler's tick interval and label precision are both derived from what
 *   is actually VISIBLE, so labels never overlap, never scatter, and never
 *   print milliseconds on a 30-second grid.
 * - Magnetic snapping to clip edges, the playhead, zero, and the grid, with a
 *   pointer-pixel radius so it feels identical at every zoom.
 * - Auto-follow during playback that steps aside when the user takes over.
 */
export function Timeline({
   tracks,
   clips,
   duration,
   selectedTrackId,
   selectedItemTrackId,
   selectedItemIndex,
   onMoveItem,
   onMoveItemToTrack,
   onCommitItemOrder,
   onRemoveItem,
   onDuplicateItem,
   onSelectItem,
   onSelectTrack,
   onAddTrack,
   onRemoveTrack,
   onUpdateItem,
   onToggleMute,
   onToggleSolo,
   onTrackVolume,
   onCloseGaps,
   onBeginItemEdit,
   onSplitItem,
   playhead = 0,
   onSeek,
   playing = false,
   externalDrag = null,
   onExternalHoverChange,
}: TimelineProps) {
   const containerRef = useRef<HTMLDivElement>(null);
   const headerColRef = useRef<HTMLDivElement>(null);
   const lanesRef = useRef<HTMLDivElement>(null);

   const [viewportWidth, setViewportWidth] = useState(0);
   const [pxPerSecond, setPxPerSecond] = useState(0); // 0 = not yet measured
   const [scrollLeft, setScrollLeft] = useState(0);
   const [snapEnabled, setSnapEnabled] = useState(true);

   // Once the user (or a test driving the real UI) explicitly picks a zoom
   // level, that choice must stick — auto-fit never overrides it.
   const userZoomed = useRef(false);
   // Timestamp of the last manual navigation; auto-follow relaxes until it ages out.
   const lastManualNavRef = useRef(0);
   const programmaticScrollRef = useRef(false);

   // Drag state for moving/trimming existing items (pointer-based).
   const [dragState, setDragState] = useState<{
      trackId: string;
      index: number;
      type: "move" | "trimLeft" | "trimRight";
      startClientX: number;
      startClientY: number;
      startPosition: number;
      rawClipDuration: number;
      origTrimStart: number;
      origTrimEnd: number;
      liveTime: number; // current position/duration feedback, for the tooltip
      liveTrackId: string; // which track the pointer is currently over
      snapped: boolean;
   } | null>(null);

   // Drop target for clips dragged in from the library.
   const [dropTarget, setDropTarget] = useState<DropHover | null>(null);

   const [editDialogOpen, setEditDialogOpen] = useState(false);
   const [editingItem, setEditingItem] = useState<{ trackId: string; index: number; item: StudioTimelineItem; clip: StudioClip } | null>(null);

   // ---- Measurement --------------------------------------------------------
   // A ref read during render is not a dependency and not stable; the viewport
   // width has to be real state or the ruler, the grid and the drop maths all
   // disagree with the pixels actually on screen.
   useLayoutEffect(() => {
      const el = containerRef.current;
      if (!el) return;
      const measure = () => setViewportWidth(el.clientWidth);
      measure();
      const ro = new ResizeObserver(measure);
      ro.observe(el);
      return () => ro.disconnect();
   }, []);

   // ---- Zoom ---------------------------------------------------------------
   // Seeded as soon as the viewport has a real width — NOT deferred until the
   // first clip lands, which is what used to leave a brand-new timeline sitting
   // at a hardcoded 60 px/s showing a nine-second window with two-second ticks.
   const isDragging = !!dragState || !!externalDrag;
   /**
    * What the view should be sized to. Once anything is arranged, that's the
    * composition. While the timeline is still empty it is the MATERIAL the
    * user is about to arrange — the clip library's total length.
    *
    * This matters more than it sounds. A literally-empty timeline showing a
    * flat five minutes runs at ~1.9 px/s, so dropping a clip 50 pixels from
    * the left edge lands it at 0:30 — half a minute of silence in front of a
    * three-second clip, which is precisely how an export ends up many times
    * longer than the material in it. Sizing to the material makes the drop
    * land where it looks like it will.
    */
   const libraryTotalSeconds = useMemo(
      () => clips.reduce((sum, c) => sum + Math.max(0, c.end - c.start), 0),
      [clips],
   );
   const zoomContentSeconds = duration > 0 ? duration : libraryTotalSeconds;

   useEffect(() => {
      if (viewportWidth <= 0) return;
      setPxPerSecond((prev) => {
         if (prev <= 0) return initialZoom(viewportWidth, zoomContentSeconds);
         // A deliberate zoom is never overridden; it is only re-clamped, so a
         // window resize can't leave the view outside the legal range.
         if (userZoomed.current) return clampZoom(prev);
         // Rescaling mid-gesture would move the ground under the drag.
         if (isDragging) return prev;
         // Nothing is placed yet, so nothing can be disturbed: track the
         // material freely.
         if (duration === 0) return initialZoom(viewportWidth, zoomContentSeconds);
         // Once there IS an arrangement, re-fit only when the view is absurdly
         // wider than it — otherwise leave the scale alone. Auto-zooming as
         // the arrangement grows sounds helpful and is not: drag a clip 200px
         // right and the view rescales to fit it, so the clip appears to
         // spring back to nearly where it started. Growth is followed by
         // SCROLLING instead (below), which preserves the scale, and Fit is
         // one click away.
         const visible = viewportWidth / prev;
         return visible > Math.max(duration * 3, 60) ? initialZoom(viewportWidth, duration) : prev;
      });
   }, [viewportWidth, duration, zoomContentSeconds, isDragging]);

   /** Every item's span on the timeline, in composition seconds. */
   const allItemEdges = useMemo(() => {
      const edges: { trackId: string; index: number; start: number; end: number }[] = [];
      for (const track of tracks) {
         track.items.forEach((item, index) => {
            const clip = clips.find((c) => c.id === item.clipId);
            if (!clip) return;
            const dur = itemEffectiveDuration(item, clip);
            edges.push({ trackId: track.id, index, start: item.position, end: item.position + dur });
         });
      }
      return edges;
   }, [tracks, clips]);

   /** Where the item that ends the composition begins — the thing a user just placed. */
   const lastItemStart = useMemo(
      () => allItemEdges.reduce((s, e) => (e.end >= duration - 1e-6 ? Math.min(s, e.start) : s), duration),
      [allItemEdges, duration],
   );

   // Keep the end of the arrangement in view as it grows (appending a clip,
   // say) — a scroll, not a zoom, so the scale the user chose survives.
   const prevDurationRef = useRef(0);
   useEffect(() => {
      const container = containerRef.current;
      const grew = duration > prevDurationRef.current + 0.001;
      prevDurationRef.current = duration;
      if (!container || !grew || isDragging || playing) return;
      if (pxPerSecond <= 0 || container.clientWidth <= 0) return;
      const endX = duration * pxPerSecond;
      if (endX > container.scrollLeft + container.clientWidth) {
         // The MINIMUM scroll that brings the new end into view, never more.
         // Parking the end at 85% of the viewport instead threw away the start
         // of an arrangement that very nearly fitted: dropping a single 45s
         // clip at 0:04 scrolled 111px, pushing the clip's own left edge behind
         // the track-header column the instant the user let go of it — so the
         // next grab landed on the header, not the clip.
         const margin = Math.min(24, container.clientWidth * 0.05);
         const revealEnd = Math.max(0, endX + margin - container.clientWidth);
         // ...and never so far that the item that just extended the
         // composition has its own start pushed off the left edge. Seeing the
         // whole of what you just placed matters more than seeing its last
         // pixel; if that item is wider than the viewport this shows its
         // beginning, which is also where you want to be.
         const keepLastItemVisible = Math.max(0, lastItemStart * pxPerSecond - margin);
         const target = Math.min(revealEnd, keepLastItemVisible);
         if (target > container.scrollLeft) {
            programmaticScrollRef.current = true;
            container.scrollLeft = target;
         }
      }
   }, [duration, pxPerSecond, isDragging, playing, lastItemStart]);

   const effectivePxPerSecond = pxPerSecond > 0 ? pxPerSecond : 1;
   const visibleSeconds = viewportWidth > 0 ? viewportWidth / effectivePxPerSecond : 60;

   // Content width: always at least a full viewport, always with room past the
   // last clip so there is somewhere to drop the next one.
   const contentSeconds = Math.max(duration + TAIL_PAD_SECONDS, visibleSeconds * 1.05);
   const totalWidth = Math.max(viewportWidth, contentSeconds * effectivePxPerSecond);

   // The timeline works in raw content-pixel space (native browser scrolling
   // moves the viewport, not our own pan offset), so the axis offset is always
   // 0 — the single authoritative model still lives in timeAxis.ts, shared
   // with the waveform view, which DOES use a non-zero offset (manual pan).
   const axis = useMemo(() => createTimeAxis(effectivePxPerSecond, 0), [effectivePxPerSecond]);
   const pixelToTime = useCallback((px: number) => axis.toTime(px), [axis]);
   const timeToPixel = useCallback((time: number) => axis.toPixel(time), [axis]);

   // Follows the audio clock every frame without re-rendering the timeline
   // (see playClock); the store's playhead only updates ~20 times a second.
   const playheadRef = useRef<HTMLDivElement>(null);
   useEffect(
      () =>
         playClock.subscribe((time) => {
            const el = playheadRef.current;
            if (!el) return;
            el.style.transform = `translateX(${timeToPixel(time)}px)`;
            el.dataset.playheadSeconds = String(time);
         }),
      [timeToPixel],
   );

   const noteManualNav = useCallback(() => {
      lastManualNavRef.current = Date.now();
   }, []);

   const applyZoom = useCallback(
      (next: number, anchorClientX?: number) => {
         const container = containerRef.current;
         const clamped = clampZoom(next);
         userZoomed.current = true;
         noteManualNav();
         if (container && effectivePxPerSecond > 0) {
            // Keep the time under the anchor (cursor, or the viewport centre)
            // pinned while the scale changes — the difference between zoom
            // that feels controlled and zoom that throws you across the mix.
            const rect = container.getBoundingClientRect();
            const anchorPx =
               anchorClientX !== undefined ? anchorClientX - rect.left : container.clientWidth / 2;
            const anchorTime = (container.scrollLeft + anchorPx) / effectivePxPerSecond;
            requestAnimationFrame(() => {
               if (!containerRef.current) return;
               programmaticScrollRef.current = true;
               containerRef.current.scrollLeft = Math.max(0, anchorTime * clamped - anchorPx);
            });
         }
         setPxPerSecond(clamped);
      },
      [effectivePxPerSecond, noteManualNav],
   );

   const zoomIn = useCallback(() => applyZoom(effectivePxPerSecond * 1.5), [applyZoom, effectivePxPerSecond]);
   const zoomOut = useCallback(() => applyZoom(effectivePxPerSecond / 1.5), [applyZoom, effectivePxPerSecond]);

   const fitToView = useCallback(() => {
      if (viewportWidth <= 0) return;
      userZoomed.current = true;
      noteManualNav();
      // Fit the actual composition. An empty timeline has nothing to fit, so
      // it falls back to the default window rather than an arbitrary constant.
      setPxPerSecond(duration > 0 ? fitZoom(viewportWidth, duration) : initialZoom(viewportWidth, 0));
      if (containerRef.current) {
         programmaticScrollRef.current = true;
         containerRef.current.scrollLeft = 0;
      }
   }, [viewportWidth, duration, noteManualNav]);

   // Ctrl/Cmd + wheel zooms around the cursor; a plain wheel scrolls, which is
   // what every other scrollable surface in the app does.
   useEffect(() => {
      const container = containerRef.current;
      if (!container) return;
      const onWheel = (e: WheelEvent) => {
         if (!(e.ctrlKey || e.metaKey)) return;
         e.preventDefault();
         applyZoom(effectivePxPerSecond * (e.deltaY > 0 ? 1 / 1.25 : 1.25), e.clientX);
      };
      container.addEventListener("wheel", onWheel, { passive: false });
      return () => container.removeEventListener("wheel", onWheel);
   }, [applyZoom, effectivePxPerSecond]);

   // ---- Scroll -------------------------------------------------------------
   useEffect(() => {
      const container = containerRef.current;
      if (!container) return;
      const handleScroll = () => {
         setScrollLeft(container.scrollLeft);
         if (headerColRef.current) headerColRef.current.scrollTop = container.scrollTop;
         if (programmaticScrollRef.current) {
            programmaticScrollRef.current = false;
         } else {
            noteManualNav();
         }
      };
      container.addEventListener("scroll", handleScroll, { passive: true });
      return () => container.removeEventListener("scroll", handleScroll);
   }, [noteManualNav]);

   // Auto-follow the playhead during playback. Professional behaviour: only
   // while transport is running, only when the playhead has actually left the
   // comfortable band, never while the user is mid-gesture, and never within a
   // few seconds of them scrolling somewhere deliberately.
   useEffect(() => {
      const container = containerRef.current;
      if (!container || !playing || dragState || externalDrag) return;
      if (Date.now() - lastManualNavRef.current < FOLLOW_SUSPEND_MS) return;
      const width = container.clientWidth;
      if (width <= 0) return;
      const playheadX = timeToPixel(playhead);
      const relative = playheadX - container.scrollLeft;
      if (relative < width * 0.1 || relative > width * 0.75) {
         programmaticScrollRef.current = true;
         // Land the playhead a third of the way in, not against an edge, so
         // what is coming next is visible.
         container.scrollLeft = Math.max(0, playheadX - width * 0.33);
      }
   }, [playhead, playing, timeToPixel, dragState, externalDrag]);

   // ---- Snapping -----------------------------------------------------------
   const ruler = useMemo(
      () => buildRuler(scrollLeft / effectivePxPerSecond, (scrollLeft + Math.max(viewportWidth, 1)) / effectivePxPerSecond, effectivePxPerSecond),
      [scrollLeft, viewportWidth, effectivePxPerSecond],
   );

   const snapThresholdTime = SNAP_PX / effectivePxPerSecond;

   const snapCandidatesFor = useCallback(
      (excludeTrackId: string, excludeIndex: number) => {
         const edges: number[] = [0, playhead];
         for (const e of allItemEdges) {
            if (e.trackId === excludeTrackId && e.index === excludeIndex) continue;
            edges.push(e.start, e.end);
         }
         // The visible grid is a snap target too — it is the thing the user can
         // actually see to aim at.
         const step = ruler.minorStep;
         if (step > 0 && step * effectivePxPerSecond >= 12) {
            const from = Math.max(0, Math.floor(scrollLeft / effectivePxPerSecond / step) * step);
            const to = (scrollLeft + viewportWidth) / effectivePxPerSecond;
            for (let t = from; t <= to; t += step) edges.push(t);
         }
         return edges;
      },
      [allItemEdges, playhead, ruler.minorStep, effectivePxPerSecond, scrollLeft, viewportWidth],
   );

   const snap = useCallback(
      (raw: number, excludeTrackId: string, excludeIndex: number) => {
         if (!snapEnabled) return { value: Math.max(0, raw), snapped: false };
         const r = applySnap(Math.max(0, raw), snapCandidatesFor(excludeTrackId, excludeIndex), snapThresholdTime);
         return { value: Math.max(0, r.value), snapped: r.snapped };
      },
      [snapEnabled, snapCandidatesFor, snapThresholdTime],
   );

   /** Which track lane (if any) a client-Y coordinate is over. */
   const trackAtClientY = useCallback((clientY: number): string | null => {
      const el = lanesRef.current;
      if (!el) return null;
      const lanes = el.querySelectorAll<HTMLElement>('[data-testid="timeline-track"]');
      for (const lane of Array.from(lanes)) {
         const r = lane.getBoundingClientRect();
         if (clientY >= r.top && clientY <= r.bottom) return lane.dataset.trackId || null;
      }
      return null;
   }, []);

   /** Content-space time for a client-X coordinate. */
   const timeAtClientX = useCallback(
      (clientX: number): number => {
         const el = lanesRef.current;
         if (!el) return 0;
         const r = el.getBoundingClientRect();
         return Math.max(0, pixelToTime(clientX - r.left));
      },
      [pixelToTime],
   );

   // ---- External drag (clip library -> timeline), pointer-based ------------
   useEffect(() => {
      if (!externalDrag) {
         if (dropTarget !== null) {
            setDropTarget(null);
            onExternalHoverChange?.(null);
         }
         return;
      }
      const trackId = trackAtClientY(externalDrag.clientY);
      let hover: DropHover | null = null;
      if (trackId) {
         const raw = timeAtClientX(externalDrag.clientX);
         const { value, snapped } = snap(raw, trackId, -1);
         hover = { trackId, position: value, snapped };
      }
      setDropTarget(hover);
      onExternalHoverChange?.(hover);
      // eslint-disable-next-line react-hooks/exhaustive-deps
   }, [externalDrag?.clientX, externalDrag?.clientY, externalDrag?.clipId, snap, trackAtClientY, timeAtClientX]);

   // ---- Move / trim existing items -----------------------------------------
   useEffect(() => {
      if (!dragState) return;

      const handleMove = (e: PointerEvent) => {
         const deltaX = e.clientX - dragState.startClientX;
         const deltaTime = deltaX / effectivePxPerSecond;

         if (dragState.type === "move") {
            const raw = Math.max(0, dragState.startPosition + deltaTime);
            const overTrack = trackAtClientY(e.clientY) ?? dragState.liveTrackId;
            const { value, snapped } = snap(raw, dragState.trackId, dragState.index);
            onMoveItem?.(dragState.trackId, dragState.index, value, false);
            setDragState((s) => (s ? { ...s, liveTime: value, liveTrackId: overTrack, snapped } : s));
         } else if (dragState.type === "trimLeft" && onUpdateItem) {
            const maxTrimStart = Math.max(
               0,
               dragState.rawClipDuration - dragState.origTrimEnd - MIN_ITEM_DURATION,
            );
            const newTrimStart = Math.max(0, Math.min(maxTrimStart, dragState.origTrimStart + deltaTime));
            const actualDelta = newTrimStart - dragState.origTrimStart;
            const newPosition = Math.max(0, dragState.startPosition + actualDelta);
            onUpdateItem(dragState.trackId, dragState.index, {
               trimStart: newTrimStart,
               position: newPosition,
            }, false);
            setDragState((s) => (s ? { ...s, liveTime: dragState.rawClipDuration - newTrimStart - dragState.origTrimEnd } : s));
         } else if (dragState.type === "trimRight" && onUpdateItem) {
            const maxTrimEnd = Math.max(
               0,
               dragState.rawClipDuration - dragState.origTrimStart - MIN_ITEM_DURATION,
            );
            const newTrimEnd = Math.max(0, Math.min(maxTrimEnd, dragState.origTrimEnd - deltaTime));
            onUpdateItem(dragState.trackId, dragState.index, { trimEnd: newTrimEnd }, false);
            setDragState((s) => (s ? { ...s, liveTime: dragState.rawClipDuration - dragState.origTrimStart - newTrimEnd } : s));
         }
      };

      const handleUp = (e: PointerEvent) => {
         if (dragState.type === "move") {
            const overTrack = trackAtClientY(e.clientY);
            if (overTrack && overTrack !== dragState.trackId && onMoveItemToTrack) {
               const raw = Math.max(0, dragState.startPosition + (e.clientX - dragState.startClientX) / effectivePxPerSecond);
               const { value } = snap(raw, overTrack, -1);
               // The live drag already moved the item within its own track
               // (history was checkpointed at gesture start), so the hop to
               // the new track must not push a SECOND undo entry.
               onMoveItemToTrack(dragState.trackId, dragState.index, overTrack, value, false);
            } else {
               const newIndex = onCommitItemOrder?.(dragState.trackId, dragState.index);
               if (newIndex !== undefined && newIndex !== dragState.index) {
                  onSelectItem?.(dragState.trackId, newIndex);
               }
            }
         }
         setDragState(null);
      };

      window.addEventListener("pointermove", handleMove);
      window.addEventListener("pointerup", handleUp);
      window.addEventListener("pointercancel", handleUp);
      return () => {
         window.removeEventListener("pointermove", handleMove);
         window.removeEventListener("pointerup", handleUp);
         window.removeEventListener("pointercancel", handleUp);
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
   }, [dragState?.trackId, dragState?.index, dragState?.type, effectivePxPerSecond, snap, trackAtClientY, onMoveItem, onMoveItemToTrack, onCommitItemOrder, onUpdateItem]);

   const handleTrackClick = (e: React.MouseEvent<HTMLDivElement>, trackId: string) => {
      if (e.target === e.currentTarget) {
         onSelectTrack?.(trackId);
      }
   };

   const beginItemDrag = (
      e: React.PointerEvent,
      trackId: string,
      index: number,
      type: "move" | "trimLeft" | "trimRight",
      item: StudioTimelineItem,
      rawClipDuration: number,
   ) => {
      e.preventDefault();
      e.stopPropagation();
      onSelectItem?.(trackId, index);
      onBeginItemEdit?.();
      const initialLive =
         type === "move"
            ? item.position
            : rawClipDuration - (item.trimStart ?? 0) - (item.trimEnd ?? 0);
      setDragState({
         trackId,
         index,
         type,
         startClientX: e.clientX,
         startClientY: e.clientY,
         startPosition: item.position,
         rawClipDuration,
         origTrimStart: item.trimStart ?? 0,
         origTrimEnd: item.trimEnd ?? 0,
         liveTime: initialLive,
         liveTrackId: trackId,
         snapped: false,
      });
   };

   const openEditDialog = (trackId: string, index: number) => {
      const track = tracks.find((t) => t.id === trackId);
      const item = track?.items[index];
      if (!track || !item) return;
      const clip = clips.find((c) => c.id === item.clipId);
      if (!clip) return;
      setEditingItem({ trackId, index, item, clip });
      setEditDialogOpen(true);
   };

   // ---- Ruler scrubbing ----------------------------------------------------
   const scrubbingRef = useRef(false);
   const beginScrub = (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      scrubbingRef.current = true;
      noteManualNav();
      onSeek?.(timeAtClientX(e.clientX));
      const move = (ev: PointerEvent) => {
         if (!scrubbingRef.current) return;
         onSeek?.(timeAtClientX(ev.clientX));
      };
      const up = () => {
         scrubbingRef.current = false;
         window.removeEventListener("pointermove", move);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up, { once: true });
   };

   const anySolo = tracks.some((t) => t.solo);

   const selectedItemEdge =
      selectedItemTrackId != null && selectedItemIndex != null
         ? allItemEdges.find((e) => e.trackId === selectedItemTrackId && e.index === selectedItemIndex)
         : undefined;
   const canSplit =
      !!selectedItemEdge &&
      playhead > selectedItemEdge.start + 0.05 &&
      playhead < selectedItemEdge.end - 0.05;

   const gapTrackId = selectedTrackId ?? tracks[0]?.id ?? null;
   const canCloseGaps = !!gapTrackId && (tracks.find((t) => t.id === gapTrackId)?.items.length ?? 0) > 1;

   const lanesHeight = Math.max(tracks.length * TRACK_HEIGHT, 140);

   return (
      <div className="flex flex-col gap-2 h-full min-h-0">
         {/* Timeline toolbar */}
         <div className="flex items-center justify-between gap-3 shrink-0 flex-wrap">
            <div className="flex items-baseline gap-2 min-w-0">
               <h3 className="font-semibold text-[13px] text-studio-text">Timeline</h3>
               <span className="text-[11px] text-studio-text-muted tabular-nums">
                  {tracks.length} track{tracks.length !== 1 ? "s" : ""}
               </span>
               <span
                  data-testid="timeline-duration"
                  data-duration-seconds={duration}
                  className="text-[11px] text-studio-text-faint tabular-nums"
                  title="Exported length — exactly what the timeline contains"
               >
                  · {formatClock(duration)}
               </span>
            </div>

            <div className="flex items-center gap-1.5 flex-wrap justify-end">
               <button
                  onClick={() => setSnapEnabled((s) => !s)}
                  aria-pressed={snapEnabled}
                  data-testid="timeline-snap-toggle"
                  className={`flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-medium transition ${
                     snapEnabled
                        ? "border-studio-snap/50 bg-studio-snap/15 text-studio-snap"
                        : "border-studio-border bg-studio-panel text-studio-text-muted hover:text-studio-text"
                  }`}
                  title="Magnetic snapping to clip edges, the playhead and the grid"
               >
                  <Magnet size={12} />
                  Snap
               </button>
               <button
                  onClick={() => gapTrackId && onCloseGaps?.(gapTrackId)}
                  disabled={!canCloseGaps}
                  data-testid="timeline-close-gaps"
                  className="flex items-center gap-1 rounded-md border border-studio-border bg-studio-panel px-2 py-1 text-[11px] font-medium text-studio-text-muted hover:text-studio-text hover:bg-studio-raised transition disabled:opacity-30 disabled:hover:bg-studio-panel"
                  title="Pull this track's clips together so they play back-to-back"
               >
                  <AlignHorizontalJustifyStart size={12} />
                  Close gaps
               </button>
               <button
                  onClick={() => {
                     if (canSplit && selectedItemTrackId != null && selectedItemIndex != null) {
                        onSplitItem?.(selectedItemTrackId, selectedItemIndex, precisePlayhead(playhead));
                     }
                  }}
                  disabled={!canSplit}
                  className="flex items-center gap-1 rounded-md border border-studio-border bg-studio-panel px-2 py-1 text-[11px] font-medium text-studio-text-muted hover:text-studio-text hover:bg-studio-raised transition disabled:opacity-30 disabled:hover:bg-studio-panel"
                  title="Split the selected clip at the playhead (S)"
                  data-testid="timeline-split"
               >
                  <Scissors size={12} />
                  Split
               </button>

               <div className="w-px h-4 bg-studio-border mx-0.5" />

               <div className="flex items-center rounded-md border border-studio-border bg-studio-panel overflow-hidden">
                  <button
                     onClick={zoomOut}
                     disabled={effectivePxPerSecond <= MIN_PX_PER_SECOND + 1e-9}
                     className="px-2.5 py-1 hover:bg-studio-raised transition text-[13px] leading-none text-studio-text-muted hover:text-studio-text disabled:opacity-30"
                     title="Zoom out"
                     data-testid="timeline-zoom-out"
                  >
                     −
                  </button>
                  <div className="w-px h-4 bg-studio-border" />
                  <button
                     onClick={zoomIn}
                     disabled={effectivePxPerSecond >= MAX_PX_PER_SECOND - 1e-9}
                     className="px-2.5 py-1 hover:bg-studio-raised transition text-[13px] leading-none text-studio-text-muted hover:text-studio-text disabled:opacity-30"
                     title="Zoom in"
                     data-testid="timeline-zoom-in"
                  >
                     +
                  </button>
               </div>
               <button
                  onClick={fitToView}
                  className="px-2.5 py-1 rounded-md border border-studio-border bg-studio-panel hover:bg-studio-raised transition text-[11px] font-medium text-studio-text-muted hover:text-studio-text"
                  title="Fit the whole composition in view"
                  data-testid="timeline-fit"
               >
                  Fit
               </button>
               <span
                  className="text-[10px] text-studio-text-faint tabular-nums w-20 text-right"
                  title="Time visible in the timeline viewport"
               >
                  {formatClock(visibleSeconds)} view
               </span>

               <div className="w-px h-4 bg-studio-border mx-0.5" />

               <button
                  onClick={onAddTrack}
                  className="rounded-md bg-studio-accent hover:brightness-110 transition text-[11px] font-medium flex items-center gap-1 px-2.5 py-1 text-white shadow-sm shadow-studio-accent/30"
                  title="Add track"
                  data-testid="add-track"
               >
                  <Plus size={13} />
                  Track
               </button>
            </div>
         </div>

         {/* Timeline body: fixed header column + scrollable content */}
         <div className="flex flex-1 min-h-0 rounded-xl border border-studio-border overflow-hidden bg-studio-canvas">
            {/* Fixed track-header column — never scrolls horizontally */}
            <div
               ref={headerColRef}
               className="shrink-0 overflow-hidden bg-studio-panel border-r border-studio-border"
               style={{ width: HEADER_WIDTH }}
            >
               <div
                  className="border-b border-studio-border flex items-center px-3 text-[10px] uppercase tracking-wide text-studio-text-faint font-medium"
                  style={{ height: RULER_HEIGHT }}
               >
                  Tracks
               </div>
               <div style={{ height: lanesHeight }}>
                  {tracks.map((track) => {
                     const inactive = track.muted || (anySolo && !track.solo);
                     return (
                        <div
                           key={track.id}
                           data-testid="track-header"
                           data-track-id={track.id}
                           onClick={() => onSelectTrack?.(track.id)}
                           style={{ height: TRACK_HEIGHT }}
                           className={`flex flex-col justify-center gap-1.5 px-3 border-b border-studio-border-soft cursor-pointer transition ${
                              selectedTrackId === track.id ? "bg-studio-raised" : ""
                           } ${inactive ? "opacity-60" : ""}`}
                        >
                           <div className="flex items-center justify-between gap-1">
                              <span className="text-[12px] font-medium text-studio-text truncate">{track.name}</span>
                              {tracks.length > 1 && (
                                 <button
                                    onClick={async (e) => {
                                       e.stopPropagation();
                                       if (await appConfirm(`Delete ${track.name}?`)) {
                                          onRemoveTrack?.(track.id);
                                       }
                                    }}
                                    className="p-1 -m-1 rounded text-studio-text-faint hover:text-studio-danger hover:bg-studio-danger/10 transition"
                                    title="Delete track"
                                 >
                                    <Trash2 size={11} />
                                 </button>
                              )}
                           </div>
                           <div className="flex items-center gap-1">
                              <button
                                 onClick={(e) => {
                                    e.stopPropagation();
                                    onToggleMute?.(track.id, !track.muted);
                                 }}
                                 title={track.muted ? "Unmute track" : "Mute track"}
                                 data-testid="track-mute"
                                 aria-pressed={track.muted}
                                 className={`flex items-center justify-center h-5 w-5 rounded text-[10px] font-bold transition ${
                                    track.muted
                                       ? "bg-studio-danger/20 text-studio-danger"
                                       : "bg-studio-raised text-studio-text-faint hover:text-studio-text"
                                 }`}
                              >
                                 {track.muted ? <VolumeX size={11} /> : <Volume2 size={11} />}
                              </button>
                              <button
                                 onClick={(e) => {
                                    e.stopPropagation();
                                    onToggleSolo?.(track.id, !track.solo);
                                 }}
                                 title={track.solo ? "Unsolo track" : "Solo track"}
                                 data-testid="track-solo"
                                 aria-pressed={track.solo}
                                 className={`flex items-center justify-center h-5 w-5 rounded text-[10px] font-bold transition ${
                                    track.solo
                                       ? "bg-studio-snap/20 text-studio-snap"
                                       : "bg-studio-raised text-studio-text-faint hover:text-studio-text"
                                 }`}
                              >
                                 S
                              </button>
                              <input
                                 type="range"
                                 min={0}
                                 max={200}
                                 value={Math.round((track.volume ?? 1) * 100)}
                                 onClick={(e) => e.stopPropagation()}
                                 onChange={(e) => onTrackVolume?.(track.id, parseInt(e.target.value, 10) / 100)}
                                 data-testid="track-volume"
                                 className="flex-1 min-w-0 h-1 accent-studio-accent cursor-pointer"
                                 title={`Track volume — ${Math.round((track.volume ?? 1) * 100)}%`}
                              />
                           </div>
                           <div className="flex items-center gap-1.5 text-[10px] text-studio-text-faint tabular-nums">
                              <span>{track.items.length === 0 ? "empty" : `${track.items.length} clip${track.items.length === 1 ? "" : "s"}`}</span>
                              {(track.volume ?? 1) !== 1 && (
                                 <span className="text-studio-text-muted">{Math.round((track.volume ?? 1) * 100)}%</span>
                              )}
                           </div>
                        </div>
                     );
                  })}
                  {tracks.length === 0 && (
                     <div className="flex items-center justify-center h-full text-[11px] text-studio-text-faint px-3 text-center">
                        No tracks
                     </div>
                  )}
               </div>
            </div>

            {/* Scrollable ruler + track lanes */}
            <div
               ref={containerRef}
               data-testid="timeline-container"
               data-px-per-second={effectivePxPerSecond}
               data-visible-seconds={visibleSeconds}
               className="relative flex-1 overflow-auto min-w-0"
            >
               {/* Ruler — also the scrub surface */}
               <div
                  className="sticky top-0 z-20 bg-studio-panel border-b border-studio-border cursor-ew-resize select-none touch-none"
                  style={{ minWidth: totalWidth, height: RULER_HEIGHT }}
                  data-testid="timeline-ruler"
                  onPointerDown={beginScrub}
                  title="Click or drag to move the playhead"
               >
                  {ruler.ticks.map((tick) =>
                     tick.major ? (
                        <div key={`mj-${tick.time}`}>
                           <div
                              style={{ position: "absolute", left: timeToPixel(tick.time), bottom: 0, height: 11 }}
                              className="w-px bg-studio-text-faint"
                           />
                           <span
                              style={{ position: "absolute", left: timeToPixel(tick.time) + 5, top: 5 }}
                              className="text-[10px] tabular-nums text-studio-text-muted whitespace-nowrap pointer-events-none"
                           >
                              {tick.label}
                           </span>
                        </div>
                     ) : (
                        <div
                           key={`mn-${tick.time}`}
                           style={{ position: "absolute", left: timeToPixel(tick.time), bottom: 0, height: 5 }}
                           className="w-px bg-studio-border"
                        />
                     ),
                  )}
                  {/* Playhead handle, always grabbable on the ruler itself */}
                  <div
                     style={{ position: "absolute", left: timeToPixel(playhead), bottom: 0, top: 0 }}
                     className="w-px bg-studio-playhead pointer-events-none"
                  >
                     <div
                        className="absolute top-0 -left-[6px] w-[13px] h-[10px] bg-studio-playhead"
                        style={{ clipPath: "polygon(0 0, 100% 0, 50% 100%)" }}
                     />
                  </div>
               </div>

               {/* Tracks container */}
               <div ref={lanesRef} className="relative" style={{ minWidth: totalWidth, height: lanesHeight }}>
                  {/* Background grid, aligned to the ruler */}
                  <div className="absolute inset-0 pointer-events-none">
                     {ruler.ticks.map((tick) => (
                        <div
                           key={`g-${tick.time}`}
                           style={{ left: timeToPixel(tick.time) }}
                           className={`absolute top-0 bottom-0 w-px ${tick.major ? "bg-studio-grid-major" : "bg-studio-grid-minor"}`}
                        />
                     ))}
                  </div>

                  {/* End-of-composition marker: where the exported file stops. */}
                  {duration > 0 && (
                     <div
                        data-testid="timeline-end-marker"
                        style={{ left: timeToPixel(duration) }}
                        className="absolute top-0 bottom-0 w-px bg-studio-success/40 pointer-events-none z-10"
                     >
                        <span className="absolute top-1 left-1.5 text-[9px] uppercase tracking-wide text-studio-success/70 whitespace-nowrap">
                           end
                        </span>
                     </div>
                  )}

                  {/* Playhead */}
                  <div
                     ref={playheadRef}
                     data-testid="timeline-playhead"
                     data-playhead-seconds={precisePlayhead(playhead)}
                     // transform, not left: moving it every frame of playback then
                     // only composites this element instead of re-laying out the lane.
                     style={{ transform: `translateX(${timeToPixel(precisePlayhead(playhead))}px)` }}
                     className="absolute left-0 top-0 bottom-0 w-px bg-studio-playhead pointer-events-none z-30 shadow-[0_0_8px_rgba(255,84,112,0.6)] will-change-transform"
                  />

                  {/* Tracks */}
                  {tracks.length === 0 ? (
                     <div className="absolute inset-0 flex items-center justify-center text-studio-text-muted text-sm">
                        <div className="text-center">
                           <div className="mb-2">No tracks yet</div>
                           <button onClick={onAddTrack} className="text-studio-accent hover:brightness-125 underline underline-offset-2">
                              Add your first track
                           </button>
                        </div>
                     </div>
                  ) : (
                     tracks.map((track, trackIdx) => {
                        const inactive = track.muted || (anySolo && !track.solo);
                        const isDropTrack = dropTarget?.trackId === track.id;
                        const isMoveTargetTrack =
                           dragState?.type === "move" && dragState.liveTrackId === track.id && dragState.trackId !== track.id;
                        return (
                           <div
                              key={track.id}
                              onClick={(e) => handleTrackClick(e, track.id)}
                              data-testid="timeline-track"
                              data-track-id={track.id}
                              style={{ top: trackIdx * TRACK_HEIGHT, height: TRACK_HEIGHT, minWidth: totalWidth }}
                              className={`absolute left-0 right-0 border-b border-studio-border-soft cursor-pointer transition-colors ${
                                 isDropTrack || isMoveTargetTrack
                                    ? "bg-studio-accent/10 ring-1 ring-inset ring-studio-accent/40"
                                    : selectedTrackId === track.id
                                    ? "bg-white/[0.03]"
                                    : "hover:bg-white/[0.015]"
                              } ${inactive ? "opacity-40" : ""}`}
                           >
                              {track.items.length === 0 && !isDropTrack && (
                                 <span className="absolute left-3 top-1/2 -translate-y-1/2 text-[11px] text-studio-text-faint italic pointer-events-none select-none">
                                    Drag a clip here, or use ⏎ on a clip to append it
                                 </span>
                              )}

                              {/* Drop position indicator */}
                              {isDropTrack && dropTarget && (
                                 <div
                                    data-testid="drop-indicator"
                                    data-drop-position={dropTarget.position}
                                    style={{ left: timeToPixel(dropTarget.position) }}
                                    className={`absolute top-0 bottom-0 w-0.5 pointer-events-none z-40 ${
                                       dropTarget.snapped ? "bg-studio-snap shadow-[0_0_10px_rgba(255,209,102,0.7)]" : "bg-studio-accent-strong shadow-[0_0_10px_rgba(110,161,255,0.6)]"
                                    }`}
                                 >
                                    <div
                                       className={`absolute top-1/2 -translate-y-1/2 -left-[5px] w-[11px] h-[11px] rotate-45 ${
                                          dropTarget.snapped ? "bg-studio-snap" : "bg-studio-accent-strong"
                                       }`}
                                    />
                                    <div
                                       className={`absolute top-1 left-1.5 whitespace-nowrap text-[10px] font-mono border rounded px-1.5 py-0.5 ${
                                          dropTarget.snapped
                                             ? "bg-studio-snap/20 border-studio-snap/50 text-studio-snap"
                                             : "bg-studio-raised border-studio-border text-studio-text"
                                       }`}
                                    >
                                       {formatTime(dropTarget.position)}
                                       {dropTarget.snapped ? " · snap" : ""}
                                    </div>
                                 </div>
                              )}

                              {/* Track items */}
                              {track.items.map((item, itemIdx) => {
                                 const clip = clips.find((c) => c.id === item.clipId);
                                 if (!clip) return null;
                                 const rawClipDuration = clip.end - clip.start;
                                 const clipDuration = itemEffectiveDuration(item, clip);
                                 const isDraggingThis = dragState?.trackId === track.id && dragState?.index === itemIdx;
                                 // Does this item collide with another on the
                                 // same track? Overlap is legal (it renders as
                                 // a genuine mix), but it must never be a
                                 // silent surprise in the exported file.
                                 const overlaps = track.items.some((other, oi) => {
                                    if (oi === itemIdx) return false;
                                    const otherClip = clips.find((c) => c.id === other.clipId);
                                    if (!otherClip) return false;
                                    const oStart = other.position;
                                    const oEnd = other.position + itemEffectiveDuration(other, otherClip);
                                    return oStart < item.position + clipDuration - 1e-6 && oEnd > item.position + 1e-6;
                                 });

                                 return (
                                    <TimelineClipItem
                                       key={`${track.id}-${item.clipId}-${itemIdx}`}
                                       item={item}
                                       clip={clip}
                                       clipDuration={clipDuration}
                                       pxPerSecond={effectivePxPerSecond}
                                       trackHeight={TRACK_HEIGHT}
                                       isSelected={selectedItemTrackId === track.id && selectedItemIndex === itemIdx}
                                       isDragging={isDraggingThis}
                                       overlaps={overlaps}
                                       dragType={isDraggingThis ? dragState!.type : null}
                                       dragLiveTime={isDraggingThis ? dragState!.liveTime : 0}
                                       dragSnapped={isDraggingThis ? dragState!.snapped : false}
                                       onPointerDownMove={(e) => beginItemDrag(e, track.id, itemIdx, "move", item, rawClipDuration)}
                                       onPointerDownTrimLeft={(e) => beginItemDrag(e, track.id, itemIdx, "trimLeft", item, rawClipDuration)}
                                       onPointerDownTrimRight={(e) => beginItemDrag(e, track.id, itemIdx, "trimRight", item, rawClipDuration)}
                                       onRemove={async () => {
                                          if (await appConfirm(`Remove "${clip.name}" from timeline?`)) {
                                             onRemoveItem?.(track.id, itemIdx);
                                          }
                                       }}
                                       onDuplicate={() => onDuplicateItem?.(track.id, itemIdx)}
                                       onSelect={() => onSelectItem?.(track.id, itemIdx)}
                                       onEdit={() => openEditDialog(track.id, itemIdx)}
                                    />
                                 );
                              })}
                           </div>
                        );
                     })
                  )}
               </div>
            </div>
         </div>

         {/* Edit dialog */}
         <ClipEditDialog
            open={editDialogOpen}
            onClose={() => {
               setEditDialogOpen(false);
               setEditingItem(null);
            }}
            item={editingItem?.item ?? null}
            clip={editingItem?.clip ?? null}
            onUpdate={(updates) => {
               if (editingItem) {
                  onUpdateItem?.(editingItem.trackId, editingItem.index, updates);
               }
            }}
         />
      </div>
   );
}

interface TimelineClipItemProps {
   item: StudioTimelineItem;
   clip: StudioClip;
   clipDuration: number;
   pxPerSecond: number;
   trackHeight: number;
   isSelected: boolean;
   isDragging: boolean;
   overlaps: boolean;
   dragType: "move" | "trimLeft" | "trimRight" | null;
   dragLiveTime: number;
   dragSnapped: boolean;
   onPointerDownMove: (e: React.PointerEvent) => void;
   onPointerDownTrimLeft: (e: React.PointerEvent) => void;
   onPointerDownTrimRight: (e: React.PointerEvent) => void;
   onRemove: () => void;
   onDuplicate: () => void;
   onSelect: () => void;
   onEdit: () => void;
}

function TimelineClipItem({
   item,
   clip,
   clipDuration,
   pxPerSecond,
   trackHeight,
   isSelected,
   isDragging,
   overlaps,
   dragType,
   dragLiveTime,
   dragSnapped,
   onPointerDownMove,
   onPointerDownTrimLeft,
   onPointerDownTrimRight,
   onRemove,
   onDuplicate,
   onSelect,
   onEdit,
}: TimelineClipItemProps) {
   const left = item.position * pxPerSecond;
   const width = Math.max(28, clipDuration * pxPerSecond);
   const crossfadeWidth = (item.crossfadePrev ?? 0) * pxPerSecond;
   const color = colorForSource(clip.sourceId);
   // Below this the clip is a sliver; labels and hover actions inside it would
   // just be visual noise the user can't hit anyway.
   const roomy = width > 110;
   const showActions = width > 78;

   return (
      <div
         onClick={(e) => {
            e.stopPropagation();
            onSelect();
         }}
         onDoubleClick={(e) => {
            e.stopPropagation();
            onEdit();
         }}
         onPointerDown={onPointerDownMove}
         data-testid="timeline-clip"
         data-clip-name={clip.name}
         data-position-seconds={item.position}
         data-duration-seconds={clipDuration}
         title={`${clip.name} — ${formatDuration(clipDuration)} at ${formatTime(item.position)}${overlaps ? " (overlaps another clip on this track)" : ""}`}
         style={{ left, top: 8, width, height: trackHeight - 18 }}
         className={`absolute rounded-lg cursor-grab active:cursor-grabbing transition-shadow group touch-none overflow-hidden bg-linear-to-b ${color.from} ${color.to} border ${
            isDragging
               ? `${color.ring} shadow-2xl z-50 ring-2 ring-white/40`
               : isSelected
               ? "border-2 border-white/80 shadow-lg z-20"
               : `${color.ring}/70 shadow-md hover:shadow-lg hover:brightness-110 z-10`
         }`}
      >
         {/* Decorative content texture — hints at audio without a full waveform fetch */}
         <div
            className="absolute inset-0 opacity-25 pointer-events-none mix-blend-overlay"
            style={{
               backgroundImage:
                  "repeating-linear-gradient(90deg, rgba(255,255,255,0.5) 0px, rgba(255,255,255,0.5) 1px, transparent 1px, transparent 5px)",
            }}
         />

         {/* Crossfade overlap visualization */}
         {crossfadeWidth > 0 && (
            <div
               style={{ width: Math.min(crossfadeWidth, width) }}
               className="absolute inset-y-0 left-0 bg-linear-to-r from-amber-300/50 to-transparent pointer-events-none"
            />
         )}
         {item.fadeIn > 0 && (
            <div
               style={{ width: Math.min(item.fadeIn * pxPerSecond, width * 0.4) }}
               className="absolute inset-y-0 left-0 bg-linear-to-r from-black/35 to-transparent pointer-events-none"
            />
         )}
         {item.fadeOut > 0 && (
            <div
               style={{ width: Math.min(item.fadeOut * pxPerSecond, width * 0.4) }}
               className="absolute inset-y-0 right-0 bg-linear-to-l from-black/35 to-transparent pointer-events-none"
            />
         )}

         {/* Overlap warning stripe — overlapping clips play simultaneously. */}
         {overlaps && (
            <div
               data-testid="clip-overlap-warning"
               className="absolute inset-x-0 bottom-0 h-1 pointer-events-none"
               style={{
                  backgroundImage:
                     "repeating-linear-gradient(45deg, rgba(255,209,102,0.95) 0 4px, rgba(0,0,0,0.35) 4px 8px)",
               }}
            />
         )}

         {/* Content */}
         <div className="px-2 py-1 truncate text-[11px] text-white font-medium pointer-events-none flex items-center gap-1 relative">
            <span className="truncate drop-shadow-sm">{clip.name}</span>
            {item.muted && <span className="text-[9px] opacity-90 shrink-0">[M]</span>}
            {item.volume !== 1 && <span className="text-[9px] opacity-90 shrink-0">{Math.round(item.volume * 100)}%</span>}
         </div>
         {roomy && (
            <div className="px-2 text-[9px] text-white/70 pointer-events-none tabular-nums truncate">
               {formatDuration(clipDuration)} · {formatClock(item.position)}
            </div>
         )}

         {/* Live drag/trim tooltip */}
         {isDragging && dragType && (
            <div
               data-testid="clip-drag-tooltip"
               className={`absolute -top-1 left-1/2 -translate-x-1/2 whitespace-nowrap text-[10px] font-mono border rounded px-2 py-0.5 shadow-lg z-50 ${
                  dragSnapped && dragType === "move"
                     ? "bg-studio-snap/25 border-studio-snap/60 text-studio-snap"
                     : "bg-studio-raised border-studio-border text-studio-text"
               }`}
            >
               {dragType === "move" ? formatTime(item.position) : formatTime(dragLiveTime)}
            </div>
         )}

         {showActions && (
            <>
               <button
                  onClick={(e) => {
                     e.stopPropagation();
                     onDuplicate();
                  }}
                  onPointerDown={(e) => e.stopPropagation()}
                  className="absolute top-1 right-11 p-1 bg-black/40 rounded opacity-0 group-hover:opacity-100 hover:bg-black/60 transition z-20"
                  title="Duplicate on timeline"
               >
                  <Copy size={10} className="text-white" />
               </button>
               <button
                  onClick={(e) => {
                     e.stopPropagation();
                     onEdit();
                  }}
                  onPointerDown={(e) => e.stopPropagation()}
                  className="absolute top-1 right-6 p-1 bg-black/40 rounded opacity-0 group-hover:opacity-100 hover:bg-black/60 transition z-20"
                  title="Edit clip (volume, fades, crossfade)"
               >
                  <Edit2 size={10} className="text-white" />
               </button>
               <button
                  onClick={(e) => {
                     e.stopPropagation();
                     onRemove();
                  }}
                  onPointerDown={(e) => e.stopPropagation()}
                  className="absolute top-1 right-1 p-1 bg-red-600/90 rounded opacity-0 group-hover:opacity-100 hover:bg-red-500 transition z-20"
                  title="Remove from timeline"
               >
                  <Trash2 size={10} className="text-white" />
               </button>
            </>
         )}

         {/* Trim handles — real, functional drag targets */}
         <div
            onPointerDown={(e) => {
               e.stopPropagation();
               onPointerDownTrimLeft(e);
            }}
            data-testid="trim-handle-left"
            className="absolute inset-y-0 left-0 w-2.5 cursor-ew-resize opacity-0 group-hover:opacity-100 bg-white/25 hover:bg-white/40 transition touch-none z-10"
            title="Trim start"
         />
         <div
            onPointerDown={(e) => {
               e.stopPropagation();
               onPointerDownTrimRight(e);
            }}
            data-testid="trim-handle-right"
            className="absolute inset-y-0 right-0 w-2.5 cursor-ew-resize opacity-0 group-hover:opacity-100 bg-white/25 hover:bg-white/40 transition touch-none z-10"
            title="Trim end"
         />
      </div>
   );
}
