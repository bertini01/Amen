import { useEffect, useLayoutEffect, useMemo, useRef, useState, useCallback } from "react";
import { playClock, precisePlayhead } from "@/lib/playClock";
import type { WaveformData, StudioMarker } from "../lib/studioTypes";
import { formatTime } from "../lib/studioTime";
import {
   createTimeAxis,
   buildRuler,
   clampZoom,
   fitZoom,
   initialZoom,
} from "../lib/timeAxis";
import { ZoomIn, ZoomOut, Maximize2, RotateCcw } from "lucide-react";

interface WaveformViewProps {
   waveform: WaveformData | null;
   duration: number;
   selectionStart?: number | null;
   selectionEnd?: number | null;
   onSelectionChange?: (start: number, end: number) => void;
   onSeek?: (time: number) => void;
   playhead?: number;
   markers?: StudioMarker[];
   /** True while the transport is running — enables playhead auto-follow. */
   playing?: boolean;
}

/** How long auto-follow steps aside after the user pans/zooms by hand. */
const FOLLOW_SUSPEND_MS = 2500;
/** Grab radius (pixels) for the selection edge handles. */
const EDGE_GRAB_PX = 6;

// Studio canvas palette — mirrors the `.studio-shell` CSS tokens (see
// styles.css). Canvas 2D fillStyle can't resolve `var(--...)` at draw time,
// so the values are kept here in lockstep with the token definitions.
const PALETTE = {
   bg: "#0d0d14",
   grid: "#24242f",
   gridMinor: "rgba(255,255,255,0.035)",
   center: "#2a2a38",
   label: "#8b8b9e",
   waveTop: "#6ea1ff",
   waveMid: "#8fc0ff",
   waveBottom: "#4f7ed6",
   selectionFill: "rgba(79, 140, 255, 0.16)",
   selectionEdge: "#6ea1ff",
   playhead: "#ff5470",
   marker: "#ffb454",
};

/**
 * Professional canvas-based waveform editor:
 * - Amplitude-based peak rendering with a signature gradient
 * - Zoom in/out/fit/reset, mouse-wheel zoom centered on the cursor
 * - Horizontal pan (shift+drag), click-to-seek, drag-to-select
 * - Shares its time<->pixel model with the Timeline (src/lib/timeAxis.ts)
 * - Selection start/end/duration surfaced both on-canvas and as text
 */
/** Stable default: a fresh `[]` per render would re-run the paint effect. */
const NO_MARKERS: NonNullable<WaveformViewProps["markers"]> = [];

export function WaveformView({
   waveform,
   duration,
   selectionStart = null,
   selectionEnd = null,
   onSelectionChange,
   onSeek,
   playhead = 0,
   markers = NO_MARKERS,
   playing = false,
}: WaveformViewProps) {
   const canvasRef = useRef<HTMLCanvasElement>(null);
   const containerRef = useRef<HTMLDivElement>(null);

   // Zoom state: pixels per second. Bounds come from the shared model in
   // timeAxis.ts, so the waveform and the timeline can never disagree about
   // what "as far out as you can go" means — and every zoom path routes
   // through clampZoom, so no gesture strands the view.
   const [pxPerSecond, setPxPerSecond] = useState(0); // Will be set on mount

   // Pan state: left edge time offset in seconds
   const [panX, setPanX] = useState(0);

   // Interaction state
   const [isDragging, setIsDragging] = useState(false);
   const [isPanning, setIsPanning] = useState(false);
   const [dragStart, setDragStart] = useState<number | null>(null);
   const [panStartX, setPanStartX] = useState(0);
   const [panStartOffset, setPanStartOffset] = useState(0);
   /**
    * Which end of an existing selection the pointer grabbed, if any. Without
    * this, the only way to adjust a selection is to redraw it from scratch —
    * fine for a rough grab, hopeless for "move the out-point 200ms later".
    */
   const [edgeDrag, setEdgeDrag] = useState<"start" | "end" | null>(null);
   const [hoverEdge, setHoverEdge] = useState<"start" | "end" | null>(null);
   const lastManualNavRef = useRef(0);
   const noteManualNav = useCallback(() => {
      lastManualNavRef.current = Date.now();
   }, []);

   // Canvas size follows the space the layout actually gives this panel, in
   // BOTH axes. A fixed height meant the source editor could not shrink, so
   // on a shorter window the whole waveform scrolled out of view behind the
   // controls below it — the one thing in the Studio that must never be
   // hidden. It flexes down to a still-readable minimum instead.
   const MIN_CANVAS_HEIGHT = 56;
   const MAX_CANVAS_HEIGHT = 200;
   const [canvasWidth, setCanvasWidth] = useState(800);
   const [canvasHeight, setCanvasHeight] = useState(132);
   const canvasSlotRef = useRef<HTMLDivElement>(null);

   // Tracks the container's real size continuously (not just on `window`
   // resize) — a flex-layout reflow (e.g. sibling panels changing size)
   // resizes this container without ever firing a window resize event, and
   // the default-zoom calc below must stay based on the CURRENT width or its
   // pixel<->time mapping silently drifts from what the drawn canvas has.
   useEffect(() => {
      const el = canvasSlotRef.current;
      if (!el) return;
      const ro = new ResizeObserver((entries) => {
         const rect = entries[0]?.contentRect;
         if (!rect) return;
         if (rect.width) setCanvasWidth(rect.width);
         setCanvasHeight(
            Math.round(Math.max(MIN_CANVAS_HEIGHT, Math.min(MAX_CANVAS_HEIGHT, rect.height))),
         );
      });
      ro.observe(el);
      return () => ro.disconnect();
   }, []);

   // Set intelligent default zoom: most audio is a few minutes long, so show
   // ~5 minutes of useful context rather than the whole hour-long source
   // crushed into one screen, or a few seconds of a short clip. Keeps
   // recalculating as the container settles into its final layout size,
   // until the user takes an explicit zoom action (see autoZoomRef below) —
   // a one-shot calc against an intermediate width would silently disagree
   // with the width the canvas actually ends up rendered at.
   const autoZoomRef = useRef(true);
   useEffect(() => {
      if (!autoZoomRef.current || !waveform || canvasWidth <= 0) return;
      setPxPerSecond(initialZoom(canvasWidth, waveform.duration));
   }, [waveform, canvasWidth]);

   // Fit entire audio to view
   const fitToView = useCallback(() => {
      if (!waveform) return;
      const audioDuration = waveform.duration;
      if (!audioDuration || audioDuration <= 0) return;
      autoZoomRef.current = false;
      noteManualNav();
      setPxPerSecond(fitZoom(canvasWidth, audioDuration));
      setPanX(0);
   }, [waveform, canvasWidth, noteManualNav]);

   // Reset zoom to 1:1 (100px per second is a nice default)
   const resetZoom = useCallback(() => {
      autoZoomRef.current = false;
      noteManualNav();
      setPxPerSecond(clampZoom(100));
      setPanX(0);
   }, [noteManualNav]);

   const zoomIn = useCallback(() => {
      autoZoomRef.current = false;
      noteManualNav();
      setPxPerSecond((prev) => clampZoom(prev * 1.5));
   }, [noteManualNav]);

   const zoomOut = useCallback(() => {
      autoZoomRef.current = false;
      noteManualNav();
      setPxPerSecond((prev) => clampZoom(prev / 1.5));
   }, [noteManualNav]);

   // Single authoritative time<->pixel model (shared with the Timeline;
   // see src/lib/timeAxis.ts). The waveform's offset is its manual pan (panX)
   // rather than native scrolling.
   // Memoised: a new axis each render gave timeToPixel a new identity, which
   // re-ran the canvas paint on every render, i.e. every frame of playback.
   const axis = useMemo(() => createTimeAxis(pxPerSecond, panX), [pxPerSecond, panX]);

   // The playhead line follows the audio clock every frame by updating its
   // own transform, without re-rendering this component (see playClock).
   const playheadRef = useRef<HTMLDivElement>(null);
   const placePlayhead = useCallback(
      (time: number) => {
         const el = playheadRef.current;
         if (!el) return;
         const x = axis.toPixel(time);
         const visible = x >= 0 && x <= canvasWidth;
         el.style.display = visible ? "" : "none";
         if (visible) el.style.transform = `translateX(${x - 1}px)`;
      },
      [axis, canvasWidth],
   );
   useEffect(() => playClock.subscribe(placePlayhead), [placePlayhead]);
   useLayoutEffect(() => {
      placePlayhead(precisePlayhead(playhead));
   });
   const pixelToTime = useCallback((px: number) => axis.toTime(px), [axis]);
   const timeToPixel = useCallback((time: number) => axis.toPixel(time), [axis]);

   // Render waveform
   useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas || !waveform) return;

      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const dpr = window.devicePixelRatio || 1;
      canvas.width = canvasWidth * dpr;
      canvas.height = canvasHeight * dpr;
      canvas.style.width = `${canvasWidth}px`;
      canvas.style.height = `${canvasHeight}px`;
      ctx.scale(dpr, dpr);

      ctx.fillStyle = PALETTE.bg;
      ctx.fillRect(0, 0, canvasWidth, canvasHeight);

      // Adaptive grid interval so labels never overlap (shared with the
      // Timeline's ruler — see src/lib/timeAxis.ts), with a minor sub-grid.
      // `buildRuler` also decides the LABEL PRECISION from the tick spacing,
      // so a 30-second grid reads "2:30", not "2:30.000".
      const secondsVisible = canvasWidth / pxPerSecond;
      const ruler = buildRuler(panX, panX + secondsVisible, pxPerSecond);

      ctx.lineWidth = 1;
      ctx.font = "10.5px system-ui, -apple-system, sans-serif";
      for (const tick of ruler.ticks) {
         const px = Math.round(timeToPixel(tick.time)) + 0.5;
         if (px < -10 || px > canvasWidth + 10) continue;
         if (tick.major) {
            ctx.strokeStyle = PALETTE.grid;
            ctx.beginPath();
            ctx.moveTo(px, 0);
            ctx.lineTo(px, canvasHeight);
            ctx.stroke();
            ctx.fillStyle = PALETTE.label;
            ctx.textAlign = "left";
            ctx.fillText(tick.label ?? "", px + 4, 11);
         } else {
            ctx.strokeStyle = PALETTE.gridMinor;
            ctx.beginPath();
            ctx.moveTo(px, 18);
            ctx.lineTo(px, canvasHeight);
            ctx.stroke();
         }
      }

      // Center line
      const centerY = canvasHeight / 2 + 8;
      ctx.strokeStyle = PALETTE.center;
      ctx.beginPath();
      ctx.moveTo(0, centerY);
      ctx.lineTo(canvasWidth, centerY);
      ctx.stroke();

      // Visible peak range
      const visibleStartTime = panX;
      const visibleEndTime = panX + secondsVisible;
      const visibleStartBucket = Math.max(0, Math.floor(visibleStartTime * waveform.bucketsPerSecond));
      const visibleEndBucket = Math.min(
         waveform.peaks.length,
         Math.ceil(visibleEndTime * waveform.bucketsPerSecond)
      );

      const bucketDuration = 1 / waveform.bucketsPerSecond;
      const bucketWidth = pxPerSecond * bucketDuration;
      const scale = ((canvasHeight - 16) / 2) * 0.88;

      const gradient = ctx.createLinearGradient(0, centerY - scale, 0, centerY + scale);
      gradient.addColorStop(0, PALETTE.waveTop);
      gradient.addColorStop(0.5, PALETTE.waveMid);
      gradient.addColorStop(1, PALETTE.waveBottom);
      ctx.fillStyle = gradient;

      for (let i = visibleStartBucket; i < visibleEndBucket; i++) {
         const [min, max] = waveform.peaks[i];
         const bucketTime = i / waveform.bucketsPerSecond;
         const x = timeToPixel(bucketTime);
         if (x + bucketWidth < 0 || x > canvasWidth) continue;
         const y1 = centerY + min * scale;
         const y2 = centerY + max * scale;
         const height = Math.max(1, y2 - y1);
         ctx.fillRect(x, y1, Math.max(1, bucketWidth * 0.9), height);
      }

      // Selection highlight
      if (selectionStart !== null && selectionEnd !== null) {
         const sx = timeToPixel(selectionStart);
         const ex = timeToPixel(selectionEnd);

         if (ex > 0 && sx < canvasWidth) {
            ctx.fillStyle = PALETTE.selectionFill;
            ctx.fillRect(Math.max(0, sx), 18, Math.min(canvasWidth, ex) - Math.max(0, sx), canvasHeight - 18);

            // Edges are drawn as grabbable handles, not hairlines — a
            // selection you can only redraw from scratch isn't an editable
            // selection.
            ctx.strokeStyle = PALETTE.selectionEdge;
            ctx.lineWidth = 2;
            ctx.fillStyle = PALETTE.selectionEdge;
            for (const x of [sx, ex]) {
               if (x < 0 || x > canvasWidth) continue;
               ctx.beginPath();
               ctx.moveTo(x, 18);
               ctx.lineTo(x, canvasHeight);
               ctx.stroke();
               ctx.fillRect(x - 2.5, canvasHeight - 16, 5, 14);
               ctx.fillRect(x - 2.5, 18, 5, 14);
            }

            // On-canvas duration badge, centered in the selection.
            const dur = selectionEnd - selectionStart;
            const label = formatTime(dur);
            ctx.font = "600 11px system-ui, -apple-system, sans-serif";
            const labelWidth = ctx.measureText(label).width + 14;
            const midX = Math.max(labelWidth / 2, Math.min(canvasWidth - labelWidth / 2, (Math.max(0, sx) + Math.min(canvasWidth, ex)) / 2));
            ctx.fillStyle = "rgba(10,10,16,0.85)";
            const badgeY = 22;
            ctx.beginPath();
            const rectX = midX - labelWidth / 2;
            const radius = 5;
            ctx.moveTo(rectX + radius, badgeY);
            ctx.arcTo(rectX + labelWidth, badgeY, rectX + labelWidth, badgeY + 18, radius);
            ctx.arcTo(rectX + labelWidth, badgeY + 18, rectX, badgeY + 18, radius);
            ctx.arcTo(rectX, badgeY + 18, rectX, badgeY, radius);
            ctx.arcTo(rectX, badgeY, rectX + labelWidth, badgeY, radius);
            ctx.closePath();
            ctx.fill();
            ctx.fillStyle = PALETTE.selectionEdge;
            ctx.textAlign = "center";
            ctx.fillText(label, midX, badgeY + 13);
         }
      }

      // Markers — user bookmarks, drawn as a flag at the top edge so they
      // never visually compete with the selection/playhead which span the
      // full height.
      for (const marker of markers) {
         const mx = timeToPixel(marker.time);
         if (mx < -10 || mx > canvasWidth + 10) continue;
         ctx.strokeStyle = PALETTE.marker;
         ctx.lineWidth = 1.5;
         ctx.beginPath();
         ctx.moveTo(mx, 0);
         ctx.lineTo(mx, canvasHeight);
         ctx.stroke();
         ctx.fillStyle = PALETTE.marker;
         ctx.beginPath();
         ctx.moveTo(mx, 0);
         ctx.lineTo(mx + 7, 0);
         ctx.lineTo(mx, 9);
         ctx.closePath();
         ctx.fill();
      }

      // The playhead is NOT drawn here: it moves every frame during playback,
      // and repainting the whole waveform 60 times a second just to move one
      // line cost more than a full CPU core. It is an overlay element below.
   }, [
      waveform,
      canvasWidth,
      canvasHeight,
      pxPerSecond,
      panX,
      selectionStart,
      selectionEnd,
      markers,
      timeToPixel,
   ]);

   // Mouse wheel: zoom
   const handleWheel = (e: React.WheelEvent) => {
      e.preventDefault();
      autoZoomRef.current = false;
      noteManualNav();
      const delta = e.deltaY > 0 ? 1 / 1.3 : 1.3;
      const newZoom = clampZoom(pxPerSecond * delta);

      const rect = canvasRef.current?.getBoundingClientRect();
      if (rect) {
         const mouseX = e.clientX - rect.left;
         const timeAtMouse = pixelToTime(mouseX);
         const newPanX = timeAtMouse - mouseX / newZoom;
         setPanX(Math.max(0, newPanX));
      }

      setPxPerSecond(newZoom);
   };

   /** Which selection edge (if either) is under this canvas-local pixel. */
   const edgeAt = useCallback(
      (px: number): "start" | "end" | null => {
         if (selectionStart === null || selectionEnd === null) return null;
         const sx = timeToPixel(selectionStart);
         const ex = timeToPixel(selectionEnd);
         // When the two edges are on top of each other, prefer the end — that
         // is the one a user is almost always extending.
         if (Math.abs(px - ex) <= EDGE_GRAB_PX) return "end";
         if (Math.abs(px - sx) <= EDGE_GRAB_PX) return "start";
         return null;
      },
      [selectionStart, selectionEnd, timeToPixel],
   );

   const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (!canvasRef.current || !waveform) return;

      const rect = canvasRef.current.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const timeAtClick = pixelToTime(px);

      if (e.button === 1 || e.shiftKey) {
         e.preventDefault();
         noteManualNav();
         setIsPanning(true);
         setPanStartX(e.clientX);
         setPanStartOffset(panX);
         return;
      }

      const edge = edgeAt(px);
      if (edge) {
         // Grabbing an edge adjusts THAT edge and pivots around the opposite
         // one, which stays fixed.
         setEdgeDrag(edge);
         setDragStart(edge === "start" ? selectionEnd! : selectionStart!);
         setIsDragging(true);
         return;
      }

      setDragStart(timeAtClick);
      setIsDragging(true);
   };

   const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (!canvasRef.current || !waveform) return;
      const rect = canvasRef.current.getBoundingClientRect();
      const px = e.clientX - rect.left;

      if (isPanning) {
         const deltaX = e.clientX - panStartX;
         const deltaTime = -deltaX / pxPerSecond;
         setPanX(Math.max(0, panStartOffset + deltaTime));
         return;
      }

      if (isDragging && dragStart !== null) {
         const timeAtMouse = pixelToTime(px);
         const start = Math.max(0, Math.min(duration, Math.min(dragStart, timeAtMouse)));
         const end = Math.max(0, Math.min(duration, Math.max(dragStart, timeAtMouse)));
         if (Math.abs(end - start) > 0.001) {
            onSelectionChange?.(start, end);
         }
         return;
      }

      const nextHover = edgeAt(px);
      if (nextHover !== hoverEdge) setHoverEdge(nextHover);
   };

   const handleMouseUp = (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (isPanning) {
         setIsPanning(false);
      } else if (isDragging && dragStart !== null) {
         const rect = canvasRef.current?.getBoundingClientRect();
         // A press-and-release that never really moved is a seek, not a
         // zero-width selection — unless it started on an edge handle, where
         // it means "I grabbed this and changed my mind".
         if (rect && !edgeDrag) {
            const px = e.clientX - rect.left;
            const timeAtMouse = pixelToTime(px);
            const delta = Math.abs(timeAtMouse - dragStart);
            if (delta < 0.05) {
               noteManualNav();
               onSeek?.(dragStart);
            }
         }
         setIsDragging(false);
         setDragStart(null);
         setEdgeDrag(null);
      }
   };

   // Keyboard shortcuts for zoom
   useEffect(() => {
      const handleKeyDown = (e: KeyboardEvent) => {
         if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
            return;
         }
         if (e.key === "=" || e.key === "+") {
            e.preventDefault();
            zoomIn();
         } else if (e.key === "-" || e.key === "_") {
            e.preventDefault();
            zoomOut();
         } else if (e.key === "0" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            fitToView();
         }
      };

      window.addEventListener("keydown", handleKeyDown);
      return () => window.removeEventListener("keydown", handleKeyDown);
   }, [zoomIn, zoomOut, fitToView]);

   // Auto-follow the playhead during playback. It must not fight the user:
   // only while the transport is actually running, only once the playhead
   // leaves the comfortable band, and never within a couple of seconds of a
   // deliberate pan, zoom or click-to-seek.
   useEffect(() => {
      if (!playing || isPanning || isDragging) return;
      if (Date.now() - lastManualNavRef.current < FOLLOW_SUSPEND_MS) return;
      if (canvasWidth <= 0 || pxPerSecond <= 0) return;

      const playheadX = timeToPixel(playhead);
      if (playheadX < canvasWidth * 0.1 || playheadX > canvasWidth * 0.8) {
         // Park the playhead a third of the way in, so what's coming is visible.
         setPanX(Math.max(0, playhead - (canvasWidth * 0.33) / pxPerSecond));
      }
   }, [playhead, playing, canvasWidth, pxPerSecond, timeToPixel, isPanning, isDragging]);

   return (
      <div
         ref={containerRef}
         // `flex-1 min-h-28`, never `h-full`: as a flex child in a column this
         // has to YIELD height to the controls below it. With `h-full` it
         // claimed the pane's full height, pushing the Start/End fields and
         // the Create Clip button past the pane's clipped edge — on a 873px
         // window they were rendered but physically unreachable, which made
         // clip creation impossible to discover.
         className="flex flex-col gap-2 bg-studio-panel rounded-xl p-3 border border-studio-border flex-1 min-h-28 min-w-0"
      >
         {/* Zoom controls */}
         <div className="flex items-center justify-between gap-2 shrink-0 flex-wrap">
            <div className="flex items-center gap-1">
               <button onClick={zoomOut} className="p-1.5 rounded-md hover:bg-studio-raised transition text-studio-text-muted hover:text-studio-text" title="Zoom out (-)">
                  <ZoomOut size={14} />
               </button>
               <button onClick={zoomIn} className="p-1.5 rounded-md hover:bg-studio-raised transition text-studio-text-muted hover:text-studio-text" title="Zoom in (+)">
                  <ZoomIn size={14} />
               </button>
               <button
                  onClick={fitToView}
                  data-testid="waveform-fit"
                  className="px-2 py-1.5 rounded-md hover:bg-studio-raised transition text-[11px] font-medium flex items-center gap-1 text-studio-text-muted hover:text-studio-text"
                  title="Fit entire audio (Ctrl+0)"
               >
                  <Maximize2 size={13} />
                  Fit
               </button>
               <button onClick={resetZoom} className="p-1.5 rounded-md hover:bg-studio-raised transition text-studio-text-muted hover:text-studio-text" title="Reset zoom (1:1)">
                  <RotateCcw size={14} />
               </button>
            </div>

            <div className="text-[11px] text-studio-text-faint tabular-nums">
               {Math.round(pxPerSecond)}px/s · {formatTime(panX)} — {formatTime(panX + canvasWidth / pxPerSecond)}
            </div>
         </div>

         {/* Waveform canvas — fills whatever vertical space is left */}
         <div ref={canvasSlotRef} className="relative flex-1 min-h-14 min-w-0 overflow-hidden">
            <canvas
               ref={canvasRef}
               data-testid="waveform-canvas"
               className={`rounded-lg block w-full ${
                  hoverEdge || edgeDrag ? "cursor-ew-resize" : isPanning ? "cursor-grabbing" : "cursor-crosshair"
               }`}
               onWheel={handleWheel}
               onMouseDown={handleMouseDown}
               onMouseMove={handleMouseMove}
               onMouseUp={handleMouseUp}
               onMouseLeave={handleMouseUp}
            />
            {/* Playhead overlay: moved with a transform, so playback only
                composites this element instead of repainting the canvas. */}
            {waveform && (
               <div
                  ref={playheadRef}
                  aria-hidden
                  className="pointer-events-none absolute left-0 top-0 h-full will-change-transform"
               >
                  <div className="h-full w-0.5" style={{ backgroundColor: PALETTE.playhead }} />
                  <div
                     className="absolute -left-1 top-0 h-0 w-0 border-x-[5px] border-t-8 border-x-transparent"
                     style={{ borderTopColor: PALETTE.playhead }}
                  />
               </div>
            )}
         </div>

         {/* Help text */}
         <div className="text-[11px] text-studio-text-faint shrink-0 truncate">
            {selectionStart !== null && selectionEnd !== null ? (
               <>
                  <span className="text-studio-accent-strong font-medium">
                     Selection: {formatTime(selectionStart)} → {formatTime(selectionEnd)}
                  </span>
                  {" "}({formatTime(selectionEnd - selectionStart)})
                  {" · drag an edge to adjust"}
               </>
            ) : (
               <>Click to seek · Drag to select · Scroll to zoom · Shift+drag to pan</>
            )}
         </div>
      </div>
   );
}
