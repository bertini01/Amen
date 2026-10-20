import { useEffect, useRef, useState } from "react";
import { Play, Pause, SkipBack, Volume2, VolumeX, Zap } from "lucide-react";
import { formatTime, clamp } from "../lib/studioTime";
import { assetUrl } from "../lib/api";
import { errorMessage } from "../lib/utils";
import { toast } from "../stores/toast";

/** Plain-language reason for an `HTMLMediaElement.play()` rejection. */
export function describePlaybackError(e: unknown): string {
   const name = e && typeof e === "object" && "name" in e ? String((e as { name: unknown }).name) : "";
   if (name === "NotSupportedError") {
      return "The file couldn't be loaded. It may have been moved or deleted, or its format isn't supported for playback.";
   }
   if (name === "NotAllowedError") {
      return "Playback was blocked by the system. Press Play again.";
   }
   return errorMessage(e);
}

interface PlayerBarProps {
   playing: boolean;
   playhead: number;
   duration: number;
   volume: number;
   muted: boolean;
   playbackRate: number;
   onPlay?: () => void;
   onPause?: () => void;
   onStop?: () => void;
   onSeek?: (time: number) => void;
   onVolumeChange?: (v: number) => void;
   onMuteToggle?: () => void;
   onPlaybackRateChange?: (r: number) => void;
   previewPath?: string | null;
   mode?: "source" | "timeline";
   sourcePlaybackPath?: string | null;
   /**
    * Hard playback bounds. Non-null ONLY while previewing a clip or an ad-hoc
    * selection — never derived from the waveform selection, so plain source
    * playback is never silently truncated by a selection the user left behind.
    */
   previewStart?: number | null;
   previewEnd?: number | null;
   looping?: boolean;
}

/**
 * Transport bar — the playback clock is authoritative (driven by the real
 * <audio> element's currentTime via requestAnimationFrame), never a fake
 * independent timer, so the playhead everywhere in the Studio always agrees
 * with what's actually playing.
 *
 * Keyboard shortcuts:
 * - Space: play/pause
 * - ← →: seek ±5s, Shift+← →: seek ±0.5s
 * - Home/End: jump to start/end, 0-9: jump to 0-90% of duration
 */
export function PlayerBar({
   playing,
   playhead,
   duration,
   volume,
   muted,
   playbackRate,
   onPlay,
   onPause,
   onStop,
   onSeek,
   onVolumeChange,
   onMuteToggle,
   onPlaybackRateChange,
   previewPath,
   mode = "timeline",
   sourcePlaybackPath,
   previewStart = null,
   previewEnd = null,
   looping = false,
}: PlayerBarProps) {
   const audioRef = useRef<HTMLAudioElement>(null);
   const frameRef = useRef<number>();
   /**
    * The playhead the UI asked for, read by the load handler below. Kept in a
    * ref (not a dep) so changing the requested position never re-runs the
    * source-loading effect.
    */
   const pendingSeekRef = useRef(playhead);
   pendingSeekRef.current = playhead;
   /** True from the moment a new src is set until its metadata has loaded. */
   const [srcReady, setSrcReady] = useState(false);
   /** De-duplicates the error toast: the play effect can retry the same failing src more than once. */
   const lastPlayErrorRef = useRef<{ message: string; at: number } | null>(null);

   const audioSrc = mode === "source" && sourcePlaybackPath
      ? assetUrl(sourcePlaybackPath)
      : previewPath;

   // A brand-new src has no duration yet, and assigning `currentTime` before
   // metadata arrives is silently discarded — which is exactly how "preview
   // this clip" ended up playing the whole source from 0:00. Seek on
   // loadedmetadata instead, to whatever position the store is asking for.
   useEffect(() => {
      const audio = audioRef.current;
      if (!audio) return;
      setSrcReady(false);
      const onLoaded = () => {
         const target = pendingSeekRef.current;
         if (Number.isFinite(target) && target > 0) {
            try {
               audio.currentTime = target;
            } catch {
               /* a src that rejects the seek will simply start at 0 */
            }
         }
         setSrcReady(true);
      };
      if (audio.readyState >= 1) {
         onLoaded();
         return;
      }
      audio.addEventListener("loadedmetadata", onLoaded);
      return () => audio.removeEventListener("loadedmetadata", onLoaded);
   }, [audioSrc]);

   useEffect(() => {
      const audio = audioRef.current;
      if (!audio) return;
      if (playing) {
         audio.play().catch((e: unknown) => {
            // A newer load/pause interrupting this play() is routine while
            // switching sources — not a failure worth reporting.
            if (e instanceof DOMException && e.name === "AbortError") return;
            // Anything else used to vanish silently, leaving the transport
            // showing "playing" over silence. Reset it and say why.
            onPause?.();
            const message = describePlaybackError(e);
            const now = Date.now();
            const last = lastPlayErrorRef.current;
            if (last && last.message === message && now - last.at < 2000) return;
            lastPlayErrorRef.current = { message, at: now };
            toast("Couldn't play this audio", message, "destructive");
         });
      } else {
         audio.pause();
      }
   }, [playing, audioSrc, srcReady]);

   useEffect(() => {
      const audio = audioRef.current;
      if (!audio) return;
      audio.volume = volume;
      audio.muted = muted;
      audio.playbackRate = playbackRate;
   }, [volume, muted, playbackRate]);

   // THE clock. `audio.currentTime` is the only source of playback truth in
   // the Studio: the waveform playhead, the timeline playhead, the time
   // readout and auto-scroll all read the store value this loop writes, so
   // none of them can invent a position of their own and drift.
   useEffect(() => {
      if (!playing) return;
      const loop = () => {
         const audio = audioRef.current;
         if (audio && !audio.paused) {
            const currentTime = audio.currentTime;
            if (previewEnd !== null && currentTime >= previewEnd) {
               if (looping && previewStart !== null) {
                  // Real audio-clock loop-back — reset the actual <audio>
                  // element's position, not a UI approximation, so the next
                  // frame's currentTime read is already correct.
                  audio.currentTime = previewStart;
                  onSeek?.(previewStart);
                  frameRef.current = requestAnimationFrame(loop);
                  return;
               }
               // Stop exactly at the region's end and leave the playhead
               // there, rather than running on into the rest of the source.
               audio.pause();
               onSeek?.(previewEnd);
               onPause?.();
               return;
            }
            onSeek?.(currentTime);
         }
         frameRef.current = requestAnimationFrame(loop);
      };
      frameRef.current = requestAnimationFrame(loop);
      return () => {
         if (frameRef.current) cancelAnimationFrame(frameRef.current);
      };
   }, [playing, onSeek, onPause, previewStart, previewEnd, looping]);

   // Sync an externally-driven seek (a click on the waveform/ruler, a preview
   // starting) onto the element. The 0.25s tolerance is wide enough that the
   // clock loop's own writes never bounce back as a seek, and tight enough
   // that a real jump lands immediately.
   useEffect(() => {
      const audio = audioRef.current;
      if (!audio || !srcReady) return;
      if (Math.abs(audio.currentTime - playhead) > 0.25) {
         try {
            audio.currentTime = playhead;
         } catch {
            /* out-of-range seeks are clamped by the element */
         }
      }
   }, [playhead, srcReady]);

   // Scrub shortcuts. Play/pause, Home and End deliberately live in
   // StudioView instead — it owns playback MODE, and two window listeners
   // both toggling the transport is a coin-flip waiting to happen.
   useEffect(() => {
      const handleKeyDown = (e: KeyboardEvent) => {
         if (
            e.target instanceof HTMLInputElement ||
            e.target instanceof HTMLTextAreaElement ||
            e.target instanceof HTMLSelectElement
         ) {
            return;
         }
         if (e.ctrlKey || e.metaKey || e.altKey) return;
         if (e.code === "ArrowLeft") {
            e.preventDefault();
            const delta = e.shiftKey ? 0.5 : 5;
            onSeek?.(clamp(playhead - delta, 0, duration));
         } else if (e.code === "ArrowRight") {
            e.preventDefault();
            const delta = e.shiftKey ? 0.5 : 5;
            onSeek?.(clamp(playhead + delta, 0, duration));
         } else if (/^Digit[0-9]$/.test(e.code)) {
            const digit = parseInt(e.code[5]);
            const pos = (digit / 10) * duration;
            onSeek?.(pos);
         }
      };

      window.addEventListener("keydown", handleKeyDown);
      return () => window.removeEventListener("keydown", handleKeyDown);
   }, [playhead, duration, onSeek]);

   const progressPct = duration > 0 ? Math.min(100, (playhead / duration) * 100) : 0;
   // A preview region is drawn on the transport too, so "why did it stop
   // there?" is answered before it is asked.
   const regionLeftPct =
      previewStart !== null && duration > 0 ? Math.max(0, Math.min(100, (previewStart / duration) * 100)) : null;
   const regionWidthPct =
      previewStart !== null && previewEnd !== null && duration > 0
         ? Math.max(0.5, Math.min(100, ((previewEnd - previewStart) / duration) * 100))
         : null;

   return (
      <div className="flex items-center gap-3 rounded-xl bg-studio-panel border border-studio-border px-3.5 py-2.5" title="Space=play/pause · ←/→=seek ±5s · Shift+←/→=±0.5s · Home/End=jump · 0-9=jump to %">
         <button
            onClick={onStop}
            className="rounded-lg p-2 hover:bg-studio-raised transition text-studio-text-muted hover:text-studio-text"
            title="Stop (resets to 0)"
         >
            <SkipBack size={16} />
         </button>
         <button
            onClick={() => (playing ? onPause?.() : onPlay?.())}
            className="rounded-full bg-studio-accent p-2.5 hover:brightness-110 transition text-white shadow-md shadow-studio-accent/30"
         >
            {playing ? <Pause size={17} /> : <Play size={17} className="ml-0.5" />}
         </button>

         <div className="flex items-center gap-1.5 text-[13px] text-studio-text font-mono tabular-nums shrink-0">
            <span>{formatTime(playhead)}</span>
            <span className="text-studio-text-faint">/</span>
            <span className="text-studio-text-muted">{formatTime(duration)}</span>
         </div>

         {/* Seek slider with filled progress track */}
         <div className="relative flex-1 h-4 flex items-center group">
            <div className="absolute inset-x-0 h-1.5 rounded-full bg-studio-canvas overflow-hidden">
               {regionLeftPct !== null && regionWidthPct !== null && (
                  <div
                     data-testid="transport-preview-region"
                     className="absolute inset-y-0 bg-studio-snap/35"
                     style={{ left: `${regionLeftPct}%`, width: `${regionWidthPct}%` }}
                  />
               )}
               <div className="h-full bg-studio-accent rounded-full relative" style={{ width: `${progressPct}%` }} />
            </div>
            <input
               type="range"
               min="0"
               max={Math.max(1, duration * 1000)}
               value={playhead * 1000}
               onChange={(e) => onSeek?.(parseInt(e.target.value) / 1000)}
               className="relative w-full h-4 appearance-none bg-transparent cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:shadow-md [&::-webkit-slider-thumb]:opacity-0 group-hover:[&::-webkit-slider-thumb]:opacity-100 [&::-webkit-slider-thumb]:transition-opacity"
            />
         </div>

         <div className="w-px h-6 bg-studio-border shrink-0" />

         {/* Volume */}
         <div className="flex items-center gap-1.5 shrink-0">
            <button onClick={onMuteToggle} className="rounded-lg p-1 hover:bg-studio-raised transition text-studio-text-muted hover:text-studio-text">
               {muted ? <VolumeX size={15} /> : <Volume2 size={15} />}
            </button>
            <input
               type="range"
               min="0"
               max="100"
               value={muted ? 0 : volume * 100}
               onChange={(e) => onVolumeChange?.(parseInt(e.target.value) / 100)}
               className="w-16 accent-studio-accent"
            />
         </div>

         {/* Playback rate */}
         <div className="flex items-center gap-1.5 shrink-0">
            <Zap size={13} className="text-studio-text-faint" />
            <select
               value={playbackRate}
               onChange={(e) => onPlaybackRateChange?.(parseFloat(e.target.value))}
               className="rounded-md bg-studio-canvas border border-studio-border px-1.5 py-1 text-[11px] text-studio-text-muted"
            >
               <option value={0.25}>0.25x</option>
               <option value={0.5}>0.5x</option>
               <option value={0.75}>0.75x</option>
               <option value={1.0}>1.0x</option>
               <option value={1.25}>1.25x</option>
               <option value={1.5}>1.5x</option>
               <option value={2.0}>2.0x</option>
            </select>
         </div>

         {/* Hidden audio element for playback */}
         <audio ref={audioRef} src={audioSrc || undefined} onEnded={() => onStop?.()} />
      </div>
   );
}
