import { errorMessage } from "@/lib/utils";
import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import type {
   StudioProject,
   StudioSource,
   StudioClip,
   StudioTrack,
   StudioTimelineItem,
   WaveformData,
   RenderResult,
} from "../lib/studioTypes";
import { itemEffectiveDuration, itemSpan } from "../lib/studioTypes";
import { formatTime } from "../lib/studioTime";
import { studioApi, assetUrl } from "../lib/api";
import { nanoid } from "nanoid";
import { toast } from "./toast";
import { useAppStore } from "./app";

// ---- Types ------------------------------------------------------------------

export interface PlaybackState {
   playing: boolean;
   playhead: number; // seconds
   previewPath: string | null;
   previewStale: boolean;
   volume: number; // 0..1
   muted: boolean;
   playbackRate: number; // 0.25..2.0
   mode: "source" | "timeline"; // source = play individual source, timeline = play rendered mix
   sourcePlaybackPath: string | null; // path to source being played
   /**
    * Disambiguates "playing the whole source" from "previewing a bounded
    * region" while `mode === "source"` — both play the same <audio> element,
    * but the user must never have to guess which one is happening. Null =
    * plain source playback; "__selection__" = an ad-hoc waveform selection
    * (no saved clip yet); any other value = the id of the StudioClip being
    * previewed.
    */
   previewingClipId: string | null;
   /**
    * The authoritative bounds the audio element enforces, in the current
    * mode's time domain. Non-null ONLY while previewing a clip or an ad-hoc
    * selection. Plain source playback and Timeline Mix leave these null, so
    * "play the source" can never be silently truncated by a leftover
    * selection, and "preview this clip" can never run on into the rest of the
    * source. Previously both behaviours were inferred from the waveform
    * selection, which made them impossible to tell apart.
    */
   previewStart: number | null;
   previewEnd: number | null;
   /** Loop the preview region during playback, instead of stopping at its end. Purely a transient playback preference — not saved with the project. */
   looping: boolean;
}

export interface SelectionState {
   selectedSourceId: string | null;
   selectedSourceWaveform: WaveformData | null;
   selectionStart: number | null;
   selectionEnd: number | null;
   selectedClipId: string | null;
   selectedTrackId: string | null;
   /** The timeline item (track + index within that track) currently selected. */
   selectedItemTrackId: string | null;
   selectedItemIndex: number | null;
}

export interface StudioStore {
   // State
   project: StudioProject | null;
   savedPath: string | null;
   modified: boolean;
   past: StudioProject[];
   future: StudioProject[];
   playback: PlaybackState;
   selection: SelectionState;
   waveformCache: Record<string, WaveformData>;
   /** Source whose waveform is being extracted right now, if any. */
   waveformLoadingId: string | null;
   /** The last waveform extraction that failed, shown inline with a Retry. */
   waveformError: { sourceId: string; message: string } | null;
   /** True while the timeline preview mix is being rendered. */
   previewRendering: boolean;
   loadingState: "idle" | "loading" | "saving";

   // Actions: Project lifecycle
   newProject: (name: string) => Promise<void>;
   loadProject: (path: string) => Promise<void>;
   saveProject: () => Promise<void>;
   saveProjectAs: (path: string) => Promise<void>;
   /** Rename the mix itself (the title in the toolbar), undoable like any other edit. */
   renameProject: (name: string) => void;

   // Actions: Sources
   /** Probe and add an audio file, returning the new source's id. Throws a readable error on failure. */
   addSource: (path: string) => Promise<string>;
   removeSource: (id: string) => void;
   selectSource: (id: string) => Promise<void>;
   getSourceWaveform: (id: string) => Promise<WaveformData | null>;

   // Actions: Clips
   createClipFromSelection: (name?: string) => void;
   renameClip: (id: string, name: string) => void;
   deleteClip: (id: string) => void;
   duplicateClip: (id: string) => StudioClip | null;

   // Actions: Markers (per-source navigation bookmarks; persisted with the project)
   addMarker: (sourceId: string, time: number, label?: string) => void;
   removeMarker: (sourceId: string, markerId: string) => void;
   renameMarker: (sourceId: string, markerId: string, label: string) => void;

   // Actions: Timeline
   addTrack: (name?: string) => void;
   removeTrack: (id: string) => void;
   setTrackMute: (id: string, muted: boolean) => void;
   setTrackSolo: (id: string, solo: boolean) => void;
   setTrackVolume: (id: string, volume: number) => void;
   renameTrack: (id: string, name: string) => void;

   addItemToTimeline: (
      clipId: string,
      trackId: string,
      position: number,
   ) => void;
   /** Place a clip flush against the end of everything already on `trackId` — the one-gesture way to build a sequential mix. Returns the position it landed at. */
   appendItemToTrack: (clipId: string, trackId: string) => number;
   /** Pull every item on a track leftward so they play back-to-back with no dead air, preserving order. */
   closeGaps: (trackId: string) => void;
   /**
    * Live-move an item within its track. Deliberately does NOT re-sort: a
    * mid-gesture re-sort renumbers the array under the drag and hijacks it
    * onto a neighbouring clip. Call `commitItemOrder` when the gesture ends.
    */
   moveItem: (trackId: string, index: number, newPosition: number, recordHistory?: boolean) => void;
   /** Restore the sorted-by-position invariant after a move gesture, returning where the moved item ended up. */
   commitItemOrder: (trackId: string, index: number) => number;
   /** Move an item to a different track (and position) in one operation, keeping all its clip settings. Returns the item's new index on the destination track. */
   moveItemToTrack: (
      fromTrackId: string,
      index: number,
      toTrackId: string,
      newPosition: number,
      recordHistory?: boolean,
   ) => number | null;
   removeItem: (trackId: string, index: number) => void;
   duplicateItem: (trackId: string, index: number) => void;
   /** Split a timeline item into two at `atTime` (an absolute timeline position). No-ops if `atTime` doesn't fall strictly inside the item. Both halves keep playing the same underlying audio with no fade at the cut, since it's the same continuous source content. */
   splitItem: (trackId: string, index: number, atTime: number) => void;
   updateItem: (
      trackId: string,
      index: number,
      updates: Partial<StudioTimelineItem>,
      recordHistory?: boolean,
   ) => void;
   /** Snapshot current state onto the undo stack without mutating anything — call once at the START of a continuous drag/trim gesture, so every subsequent live update during that gesture can skip pushing its own history entry and the whole gesture undoes as one step. */
   checkpointHistory: () => void;

   // Actions: Playback
   play: () => void;
   pause: () => void;
   stop: () => void;
   seek: (time: number) => void;
   setVolume: (v: number) => void;
   setMuted: (m: boolean) => void;
   setPlaybackRate: (r: number) => void;
   /** Load a clip's source, set the selection to its bounds, and play ONLY that region — unambiguously labeled as a CLIP PREVIEW, never mistaken for full-source playback. */
   previewClip: (clipId: string) => Promise<void>;
   /** Play the current ad-hoc waveform selection (no saved clip yet), labeled as a preview rather than full-source playback. */
   previewSelection: () => void;
   /** Leave any bounded preview and play the whole selected source from the playhead. */
   playFullSource: () => void;
   /** Toggle looping the current preview region during playback. */
   toggleLoop: () => void;

   // Actions: Rendering
   /** Render the timeline mix for playback. Never throws: failures are toasted and leave the preview stale, so "Update Preview" stays available as the retry. */
   renderPreview: () => Promise<void>;
   /** Export the mix. Resolves null only when no project is open; render failures throw a readable error. */
   exportMix: (
      outputPath: string,
      format: string,
      bitrateKbps: number,
   ) => Promise<RenderResult | null>;
   exportClip: (
      clipId: string,
      outputPath: string,
      format: string,
      bitrateKbps: number,
   ) => Promise<RenderResult | null>;

   // Actions: History
   undo: () => void;
   redo: () => void;
   canUndo: () => boolean;
   canRedo: () => boolean;

   // Actions: Selection & Editing
   setSelectionStart: (time: number | null) => void;
   setSelectionEnd: (time: number | null) => void;
   setSelectedClip: (id: string | null) => void;
   setSelectedTrack: (id: string | null) => void;
   setSelectedItem: (trackId: string | null, index: number | null) => void;

   // Actions: Utilities
   getMissingSources: () => Promise<StudioSource[]>;
}

// ---- Store Implementation ---------------------------------------------------

/** How many edits deep undo goes. Each entry is a full project snapshot, so
 *  this is a memory bound as much as a UX one. */
const HISTORY_LIMIT = 100;

/** Shortest span that can become a clip — below this it's a mis-click, not a selection. */
export const MIN_CLIP_DURATION = 0.02;

/**
 * Snapshot the current project onto the undo stack and invalidate redo.
 * Every mutating action funnels through this so the stack can never grow
 * without bound (the previous inline `state.past = [...state.past, snap]`
 * pattern was uncapped) and so undo semantics stay identical everywhere.
 */
function pushHistory(state: StudioStore) {
   if (!state.project) return;
   state.past = [...state.past, JSON.parse(JSON.stringify(state.project))].slice(-HISTORY_LIMIT);
   state.future = [];
}

/**
 * Re-establish invariants after undo/redo swaps the whole project out.
 * Selections are (trackId, index) pairs into an array that just changed
 * shape, so a stale index would point at a different clip — or past the end —
 * and the next Delete/Split keystroke would act on the wrong thing. The
 * rendered timeline preview is also no longer what the timeline says.
 */
function afterHistoryJump(state: StudioStore) {
   state.playback.previewStale = true;
   const project = state.project;
   const trackId = state.selection.selectedItemTrackId;
   const index = state.selection.selectedItemIndex;
   if (!project || trackId === null || index === null) return;
   const track = project.timeline.tracks.find((t) => t.id === trackId);
   if (!track || !track.items[index]) {
      state.selection.selectedItemTrackId = null;
      state.selection.selectedItemIndex = null;
   }
}

/** A fresh timeline placement with neutral settings. */
function newItem(clipId: string, position: number): StudioTimelineItem {
   return {
      clipId,
      position: Math.max(0, position),
      volume: 1.0,
      muted: false,
      fadeIn: 0,
      fadeOut: 0,
      crossfadePrev: 0,
      trimStart: 0,
      trimEnd: 0,
   };
}

/** Where the content on a track currently ends — i.e. where the next clip appended to it goes. */
function trackEnd(track: StudioTrack, project: StudioProject): number {
   let end = 0;
   for (const item of track.items) {
      const clip = project.clips.find((c) => c.id === item.clipId);
      if (!clip) continue;
      end = Math.max(end, itemSpan(item, clip).end);
   }
   return end;
}

const createDefaultProject = (name: string): StudioProject => ({
   version: 1,
   name,
   createdAt: Date.now(),
   modifiedAt: Date.now(),
   sources: [],
   clips: [],
   timeline: {
      tracks: [
         {
            id: "track-1",
            name: "Track 1",
            muted: false,
            solo: false,
            volume: 1,
            items: [],
         },
      ],
   },
   export: {
      title: name,
      artist: "",
      album: "",
      year: new Date().getFullYear().toString(),
      comment: "",
      artwork: null,
   },
   settings: {
      sampleRate: 44100,
      normalize: "none",
      normalizeTargetDb: -3,
      normalizeLufs: -16,
   },
});

export const useStudioStore = create<StudioStore>()(
   immer((set, get) => ({
      project: null,
      savedPath: null,
      modified: false,
      past: [],
      future: [],
      playback: {
         playing: false,
         playhead: 0,
         previewPath: null,
         previewStale: true,
         volume: 0.8,
         muted: false,
         playbackRate: 1.0,
         mode: "source",
         sourcePlaybackPath: null,
         previewingClipId: null,
         previewStart: null,
         previewEnd: null,
         looping: false,
      },
      selection: {
         selectedSourceId: null,
         selectedSourceWaveform: null,
         selectionStart: null,
         selectionEnd: null,
         selectedClipId: null,
         selectedTrackId: null,
         selectedItemTrackId: null,
         selectedItemIndex: null,
      },
      waveformCache: {},
      waveformLoadingId: null,
      waveformError: null,
      previewRendering: false,
      loadingState: "idle",

      // ---- Project Lifecycle --------------------------------------------------

      newProject: async (name: string) => {
         set((state: StudioStore) => {
            state.project = createDefaultProject(name);
            state.savedPath = null;
            state.modified = false;
            state.past = [];
            state.future = [];
            state.selection = {
               selectedSourceId: null,
               selectedSourceWaveform: null,
               selectionStart: null,
               selectionEnd: null,
               selectedClipId: null,
               selectedTrackId: null,
               selectedItemTrackId: null,
               selectedItemIndex: null,
            };
            state.playback = {
               playing: false,
               playhead: 0,
               previewPath: null,
               previewStale: true,
               volume: 0.8,
               muted: false,
               playbackRate: 1.0,
               mode: "source",
               sourcePlaybackPath: null,
               previewingClipId: null,
               previewStart: null,
               previewEnd: null,
               looping: false,
            };
            state.waveformCache = {};
            state.waveformLoadingId = null;
            state.waveformError = null;
            state.loadingState = "idle";
         });
      },

      loadProject: async (path: string) => {
         set((state: StudioStore) => {
            state.loadingState = "loading";
         });
         try {
            const loaded = await studioApi.loadProject(path);
            // Projects saved before per-track gain existed arrive without a
            // `volume`; default them to unity rather than letting `undefined`
            // reach a gain slider (which would render as 0 = silent).
            for (const track of loaded.timeline.tracks) {
               if (typeof track.volume !== "number" || !isFinite(track.volume)) track.volume = 1;
            }
            set((state: StudioStore) => {
               state.project = loaded;
               state.savedPath = path;
               state.modified = false;
               state.past = [];
               state.future = [];
               state.selection = {
                  selectedSourceId: null,
                  selectedSourceWaveform: null,
                  selectionStart: null,
                  selectionEnd: null,
                  selectedClipId: null,
                  selectedTrackId: null,
                  selectedItemTrackId: null,
                  selectedItemIndex: null,
               };
               state.waveformLoadingId = null;
               state.waveformError = null;
               state.loadingState = "idle";
            });
         } catch (e) {
            set((state: StudioStore) => {
               state.loadingState = "idle";
            });
            throw e;
         }
      },

      saveProject: async () => {
         const savedPath = get().savedPath;
         if (!get().project || !savedPath) {
            throw new Error("No project path set; use saveProjectAs first.");
         }
         // Immer freezes committed state in development; mutate `modifiedAt`
         // through a producer (not directly on the object from get()), then
         // re-read the up-to-date project for the actual save call.
         set((s: StudioStore) => {
            if (s.project) s.project.modifiedAt = Date.now();
            s.loadingState = "saving";
         });
         try {
            const project = get().project;
            if (project) {
               await studioApi.saveProject(project, savedPath);
            }
            set((s: StudioStore) => {
               s.modified = false;
               s.loadingState = "idle";
            });
         } catch (e) {
            set((s: StudioStore) => {
               s.loadingState = "idle";
            });
            throw e;
         }
      },

      saveProjectAs: async (path: string) => {
         if (!get().project) throw new Error("No project loaded.");
         set((s: StudioStore) => {
            if (s.project) s.project.modifiedAt = Date.now();
            s.loadingState = "saving";
            // Naming the FILE names the MIX. Choosing "Praise Vol 1.lms" in the
            // save dialog and still seeing "Untitled Mix" in the toolbar reads
            // as the name having been ignored — the file name is the only name
            // the user was ever asked for.
            const stem = path
               .split(/[\\/]/)
               .pop()!
               .replace(/\.lms$/i, "")
               .trim();
            if (s.project && stem) s.project.name = stem;
         });
         try {
            const project = get().project;
            if (project) {
               await studioApi.saveProject(project, path);
            }
            set((s: StudioStore) => {
               s.savedPath = path;
               s.modified = false;
               s.loadingState = "idle";
            });
         } catch (e) {
            set((s: StudioStore) => {
               s.loadingState = "idle";
            });
            throw e;
         }
      },

      // ---- Sources, Clips, Timeline omitted for brevity (same implementation) ----
      // All state mutations following the same pattern as above.

      addSource: async (path: string) => {
         try {
            const info = await studioApi.probeAudio(path);
            const id = nanoid();
            set((state: StudioStore) => {
               // Callers outside the Studio (Downloads, History) can get here
               // before the Studio view has ever mounted. Dropping the source
               // because no project exists yet is how "Open in Audio Studio"
               // used to land on an empty workspace.
               if (!state.project) state.project = createDefaultProject("Untitled Mix");
               pushHistory(state);
               state.project.sources.push({
                  id,
                  path,
                  name: path.split(/[\\/]/).pop() || "Audio",
                  duration: info.duration,
                  sampleRate: info.sampleRate,
                  channels: info.channels,
                  bpm: null,
                  markers: [],
               });
               state.modified = true;
            });
            return id;
         } catch (e) {
            throw new Error(errorMessage(e));
         }
      },

      removeSource: (id: string) => {
         set((state: StudioStore) => {
            if (!state.project) return;
            pushHistory(state);
            const removedClipIds = new Set(
               state.project.clips.filter((c) => c.sourceId === id).map((c) => c.id),
            );
            state.project.sources = state.project.sources.filter(
               (s) => s.id !== id,
            );
            state.project.clips = state.project.clips.filter(
               (c) => c.sourceId !== id,
            );
            // A clip that no longer exists can't stay referenced on the
            // timeline — the Timeline UI silently hides such items (renders
            // nothing for them) rather than crash, which would otherwise
            // leave an invisible, permanently un-exportable dangling
            // reference the user has no way to discover or remove.
            state.project.timeline.tracks.forEach((track) => {
               track.items = track.items.filter((item) => !removedClipIds.has(item.clipId));
            });
            if (state.selection.selectedSourceId === id) {
               state.selection.selectedSourceId = null;
               state.selection.selectedSourceWaveform = null;
            }
            if (state.selection.selectedClipId && removedClipIds.has(state.selection.selectedClipId)) {
               state.selection.selectedClipId = null;
            }
            state.modified = true;
            state.playback.previewStale = true;
         });
      },

      selectSource: async (id: string) => {
         const state = get();
         const src = state.project?.sources.find((s) => s.id === id);
         set((state: StudioStore) => {
            state.selection.selectedSourceId = id;
            // Never leave the PREVIOUS source's waveform on screen under the
            // new source's name while this one loads (or if it fails to).
            state.selection.selectedSourceWaveform = state.waveformCache[id] ?? null;
            state.selection.selectionStart = null;
            state.selection.selectionEnd = null;
            // Switch to source playback mode and set source path
            if (src) {
               state.playback.mode = "source";
               state.playback.sourcePlaybackPath = src.path;
               state.playback.playhead = 0;
               state.playback.playing = false;
               state.playback.previewingClipId = null;
               state.playback.previewStart = null;
               state.playback.previewEnd = null;
               state.playback.looping = false;
            }
         });
         await get().getSourceWaveform(id);
      },

      getSourceWaveform: async (id: string) => {
         const state = get();
         if (!state.project) return null;
         const src = state.project.sources.find((s) => s.id === id);
         if (!src) return null;
         if (state.waveformCache[id]) {
            set((s: StudioStore) => {
               s.selection.selectedSourceWaveform = state.waveformCache[id];
            });
            return state.waveformCache[id];
         }
         set((s: StudioStore) => {
            s.waveformLoadingId = id;
            if (s.waveformError?.sourceId === id) s.waveformError = null;
         });
         try {
            const wf = await studioApi.waveform(src.path, 10);
            set((s: StudioStore) => {
               s.waveformCache[id] = wf;
               if (s.waveformLoadingId === id) s.waveformLoadingId = null;
               if (s.selection.selectedSourceId === id) {
                  s.selection.selectedSourceWaveform = wf;
               }
            });
            return wf;
         } catch (e) {
            // Previously console-only, so the editor just stayed blank. The
            // reason is now shown inline in the editor pane with a Retry.
            set((s: StudioStore) => {
               if (s.waveformLoadingId === id) s.waveformLoadingId = null;
               s.waveformError = { sourceId: id, message: errorMessage(e) };
            });
            return null;
         }
      },

      createClipFromSelection: (name?: string) => {
         set((state: StudioStore) => {
            if (!state.project || !state.selection.selectedSourceId) return;
            const { selectionStart, selectionEnd } = state.selection;
            // A clip with no real selection behind it used to fall back to
            // 0 -> 1s, quietly producing a one-second clip the user never
            // asked for. Refusing is honest; the UI keeps the button disabled.
            if (selectionStart === null || selectionEnd === null) return;
            const start = Math.max(0, Math.min(selectionStart, selectionEnd));
            const end = Math.max(selectionStart, selectionEnd);
            if (end - start < MIN_CLIP_DURATION) return;
            const id = nanoid();
            pushHistory(state);
            state.project.clips.push({
               id,
               sourceId: state.selection.selectedSourceId,
               name: name || `Clip ${state.project.clips.length + 1}`,
               start,
               end,
            });
            state.selection.selectedClipId = id;
            state.modified = true;
         });
      },

      renameProject: (name: string) => {
         const trimmed = name.trim();
         set((state: StudioStore) => {
            if (!state.project) return;
            // An empty title would leave the toolbar blank with nothing to
            // click on to fix it, so a cleared name reverts to the default.
            const next = trimmed || "Untitled Mix";
            if (state.project.name === next) return;
            pushHistory(state);
            state.project.name = next;
            state.modified = true;
         });
      },

      renameClip: (id: string, name: string) => {
         set((state: StudioStore) => {
            if (!state.project) return;
            const clip = state.project.clips.find((c) => c.id === id);
            if (clip) {
               pushHistory(state);
               clip.name = name;
               state.modified = true;
            }
         });
      },

      deleteClip: (id: string) => {
         set((state: StudioStore) => {
            if (!state.project) return;
            pushHistory(state);
            state.project.clips = state.project.clips.filter(
               (c) => c.id !== id,
            );
            state.project.timeline.tracks.forEach((track) => {
               track.items = track.items.filter((item) => item.clipId !== id);
            });
            if (state.selection.selectedClipId === id) {
               state.selection.selectedClipId = null;
            }
            state.modified = true;
         });
      },

      duplicateClip: (id: string) => {
         let dup: StudioClip | null = null;
         set((state: StudioStore) => {
            if (!state.project) return;
            const orig = state.project.clips.find((c) => c.id === id);
            if (!orig) return;
            pushHistory(state);
            dup = {
               id: nanoid(),
               sourceId: orig.sourceId,
               name: `${orig.name} (copy)`,
               start: orig.start,
               end: orig.end,
            };
            state.project.clips.push(dup);
            state.modified = true;
         });
         return dup;
      },

      addMarker: (sourceId: string, time: number, label?: string) => {
         set((state: StudioStore) => {
            if (!state.project) return;
            const src = state.project.sources.find((s) => s.id === sourceId);
            if (!src) return;
            pushHistory(state);
            const clamped = Math.max(0, Math.min(src.duration, time));
            src.markers.push({
               id: nanoid(),
               time: clamped,
               label: label || formatTime(clamped),
            });
            src.markers.sort((a, b) => a.time - b.time);
            state.modified = true;
         });
      },

      removeMarker: (sourceId: string, markerId: string) => {
         set((state: StudioStore) => {
            if (!state.project) return;
            const src = state.project.sources.find((s) => s.id === sourceId);
            if (!src) return;
            pushHistory(state);
            src.markers = src.markers.filter((m) => m.id !== markerId);
            state.modified = true;
         });
      },

      renameMarker: (sourceId: string, markerId: string, label: string) => {
         set((state: StudioStore) => {
            if (!state.project) return;
            const src = state.project.sources.find((s) => s.id === sourceId);
            const marker = src?.markers.find((m) => m.id === markerId);
            if (!marker) return;
            pushHistory(state);
            marker.label = label;
            state.modified = true;
         });
      },

      addTrack: (name?: string) => {
         set((state: StudioStore) => {
            if (!state.project) return;
            pushHistory(state);
            const idx = state.project.timeline.tracks.length;
            state.project.timeline.tracks.push({
               id: nanoid(),
               name: name || `Track ${idx + 1}`,
               muted: false,
               solo: false,
               volume: 1,
               items: [],
            });
            state.modified = true;
         });
      },

      removeTrack: (id: string) => {
         set((state: StudioStore) => {
            if (!state.project) return;
            pushHistory(state);
            state.project.timeline.tracks =
               state.project.timeline.tracks.filter((t) => t.id !== id);
            if (state.selection.selectedTrackId === id)
               state.selection.selectedTrackId = null;
            if (state.selection.selectedItemTrackId === id) {
               state.selection.selectedItemTrackId = null;
               state.selection.selectedItemIndex = null;
            }
            state.modified = true;
         });
      },

      setTrackMute: (id: string, muted: boolean) => {
         set((state: StudioStore) => {
            if (!state.project) return;
            const track = state.project.timeline.tracks.find(
               (t) => t.id === id,
            );
            if (track) track.muted = muted;
         });
      },

      setTrackSolo: (id: string, solo: boolean) => {
         set((state: StudioStore) => {
            if (!state.project) return;
            const track = state.project.timeline.tracks.find(
               (t) => t.id === id,
            );
            if (track) track.solo = solo;
         });
      },

      setTrackVolume: (id: string, volume: number) => {
         set((state: StudioStore) => {
            if (!state.project) return;
            const track = state.project.timeline.tracks.find((t) => t.id === id);
            if (!track) return;
            track.volume = Math.max(0, Math.min(2, volume));
            state.modified = true;
            state.playback.previewStale = true;
         });
      },

      renameTrack: (id: string, name: string) => {
         set((state: StudioStore) => {
            if (!state.project) return;
            const track = state.project.timeline.tracks.find((t) => t.id === id);
            if (!track || !name.trim()) return;
            pushHistory(state);
            track.name = name.trim();
            state.modified = true;
         });
      },

      addItemToTimeline: (
         clipId: string,
         trackId: string,
         position: number,
      ) => {
         set((state: StudioStore) => {
            if (!state.project) return;
            pushHistory(state);
            const track = state.project.timeline.tracks.find(
               (t) => t.id === trackId,
            );
            if (!track) return;
            track.items.push({
               clipId,
               position,
               volume: 1.0,
               muted: false,
               fadeIn: 0,
               fadeOut: 0,
               crossfadePrev: 0,
               trimStart: 0,
               trimEnd: 0,
            });
            track.items.sort((a, b) => a.position - b.position);
            state.modified = true;
            state.playback.previewStale = true;
         });
      },

      appendItemToTrack: (clipId: string, trackId: string) => {
         let landedAt = 0;
         set((state: StudioStore) => {
            if (!state.project) return;
            const track = state.project.timeline.tracks.find((t) => t.id === trackId);
            if (!track) return;
            landedAt = trackEnd(track, state.project);
            pushHistory(state);
            track.items.push(newItem(clipId, landedAt));
            track.items.sort((a, b) => a.position - b.position);
            state.selection.selectedTrackId = trackId;
            state.selection.selectedItemTrackId = trackId;
            state.selection.selectedItemIndex = track.items.findIndex(
               (i) => i.clipId === clipId && i.position === landedAt,
            );
            state.modified = true;
            state.playback.previewStale = true;
         });
         return landedAt;
      },

      closeGaps: (trackId: string) => {
         set((state: StudioStore) => {
            if (!state.project) return;
            const project = state.project;
            const track = project.timeline.tracks.find((t) => t.id === trackId);
            if (!track || track.items.length === 0) return;
            const ordered = [...track.items].sort((a, b) => a.position - b.position);
            // Work the new layout out FIRST, without touching the draft: the
            // undo snapshot has to capture the pre-compaction state, and a
            // track that is already gapless must not burn an undo step (or
            // mark the project dirty) on a no-op click.
            let cursor = 0;
            let changed = false;
            const targets: number[] = [];
            for (const item of ordered) {
               const clip = project.clips.find((c) => c.id === item.clipId);
               if (!clip) {
                  targets.push(item.position);
                  continue;
               }
               // A crossfade means this clip is MEANT to overlap its
               // predecessor; compacting preserves that overlap rather than
               // silently flattening the transition into a hard cut.
               const overlap = Math.max(0, item.crossfadePrev);
               const target = cursor + overlap;
               if (Math.abs(item.position - target) > 1e-6) changed = true;
               targets.push(target);
               cursor = target - overlap + itemEffectiveDuration(item, clip);
            }
            if (!changed) return;
            pushHistory(state);
            const compacted = [...track.items].sort((a, b) => a.position - b.position);
            compacted.forEach((item, i) => {
               item.position = targets[i];
            });
            track.items = compacted;
            state.modified = true;
            state.playback.previewStale = true;
         });
      },

      moveItem: (trackId: string, index: number, newPosition: number, recordHistory = true) => {
         set((state: StudioStore) => {
            if (!state.project) return;
            const track = state.project.timeline.tracks.find(
               (t) => t.id === trackId,
            );
            if (!track || !track.items[index]) return;
            if (recordHistory) {
               pushHistory(state);
            }
            // Deliberately NOT re-sorted here. Sorting mid-drag renumbers the
            // array under the gesture, so the moment a clip is dragged past a
            // neighbour the drag would silently switch to moving that
            // neighbour instead. `commitItemOrder` restores the sorted
            // invariant once the pointer is released.
            track.items[index].position = Math.max(0, newPosition);
            state.modified = true;
            state.playback.previewStale = true;
         });
      },

      moveItemToTrack: (
         fromTrackId: string,
         index: number,
         toTrackId: string,
         newPosition: number,
         recordHistory = true,
      ) => {
         let newIndex: number | null = null;
         set((state: StudioStore) => {
            if (!state.project) return;
            const tracks = state.project.timeline.tracks;
            const from = tracks.find((t) => t.id === fromTrackId);
            const to = tracks.find((t) => t.id === toTrackId);
            if (!from || !to || !from.items[index]) return;
            if (recordHistory) pushHistory(state);
            const [item] = from.items.splice(index, 1);
            item.position = Math.max(0, newPosition);
            // A crossfade is a relationship with the PREVIOUS clip on the same
            // track. Carrying it across would make the new track's unrelated
            // neighbour bleed into this clip, so it's dropped on the move.
            item.crossfadePrev = 0;
            to.items.push(item);
            to.items.sort((a, b) => a.position - b.position);
            newIndex = to.items.indexOf(item);
            state.selection.selectedTrackId = toTrackId;
            state.selection.selectedItemTrackId = toTrackId;
            state.selection.selectedItemIndex = newIndex;
            state.modified = true;
            state.playback.previewStale = true;
         });
         return newIndex;
      },

      commitItemOrder: (trackId: string, index: number) => {
         let newIndex = index;
         set((state: StudioStore) => {
            if (!state.project) return;
            const track = state.project.timeline.tracks.find((t) => t.id === trackId);
            if (!track || !track.items[index]) return;
            const item = track.items[index];
            track.items.sort((a, b) => a.position - b.position);
            newIndex = track.items.indexOf(item);
            if (
               state.selection.selectedItemTrackId === trackId &&
               state.selection.selectedItemIndex === index
            ) {
               state.selection.selectedItemIndex = newIndex;
            }
         });
         return newIndex;
      },

      checkpointHistory: () => {
         set((state: StudioStore) => {
            if (!state.project) return;
            pushHistory(state);
         });
      },

      removeItem: (trackId: string, index: number) => {
         set((state: StudioStore) => {
            if (!state.project) return;
            const track = state.project.timeline.tracks.find(
               (t) => t.id === trackId,
            );
            if (!track) return;
            pushHistory(state);
            track.items.splice(index, 1);
            if (state.selection.selectedItemTrackId === trackId) {
               if (state.selection.selectedItemIndex === index) {
                  state.selection.selectedItemTrackId = null;
                  state.selection.selectedItemIndex = null;
               } else if (
                  state.selection.selectedItemIndex !== null &&
                  state.selection.selectedItemIndex > index
               ) {
                  state.selection.selectedItemIndex -= 1;
               }
            }
            state.modified = true;
            state.playback.previewStale = true;
         });
      },

      duplicateItem: (trackId: string, index: number) => {
         set((state: StudioStore) => {
            if (!state.project) return;
            const track = state.project.timeline.tracks.find((t) => t.id === trackId);
            const item = track?.items[index];
            if (!track || !item) return;
            const clip = state.project.clips.find((c) => c.id === item.clipId);
            const clipDuration = clip ? clip.end - clip.start - (item.trimStart ?? 0) - (item.trimEnd ?? 0) : 0;
            pushHistory(state);
            track.items.push({
               ...item,
               position: item.position + Math.max(0.01, clipDuration),
               crossfadePrev: 0,
            });
            track.items.sort((a, b) => a.position - b.position);
            state.modified = true;
            state.playback.previewStale = true;
         });
      },

      updateItem: (
         trackId: string,
         index: number,
         updates: Partial<StudioTimelineItem>,
         recordHistory = true,
      ) => {
         set((state: StudioStore) => {
            if (!state.project) return;
            const track = state.project.timeline.tracks.find(
               (t) => t.id === trackId,
            );
            if (!track || !track.items[index]) return;
            if (recordHistory) {
               pushHistory(state);
            }
            Object.assign(track.items[index], updates);
            state.modified = true;
            state.playback.previewStale = true;
         });
      },

      splitItem: (trackId: string, index: number, atTime: number) => {
         set((state: StudioStore) => {
            if (!state.project) return;
            const track = state.project.timeline.tracks.find((t) => t.id === trackId);
            const item = track?.items[index];
            if (!track || !item) return;
            const clip = state.project.clips.find((c) => c.id === item.clipId);
            if (!clip) return;

            const MIN_PIECE_DURATION = 0.05;
            const duration = itemEffectiveDuration(item, clip);
            const splitOffset = atTime - item.position;
            // Refuse a split that doesn't fall strictly inside the item, or
            // would leave a sliver too small to be a meaningful clip.
            if (splitOffset < MIN_PIECE_DURATION || splitOffset > duration - MIN_PIECE_DURATION) return;

            pushHistory(state);

            const originalTrimEnd = item.trimEnd ?? 0;
            const originalFadeOut = item.fadeOut;
            // Both halves keep playing the exact same continuous underlying
            // audio at the cut, so neither gets a fade there — only the
            // outer edges (the original fadeIn/fadeOut) are preserved, and
            // each stays on whichever half now owns that edge.
            item.trimEnd = originalTrimEnd + (duration - splitOffset);
            item.fadeOut = 0;

            track.items.push({
               ...item,
               position: atTime,
               trimStart: (item.trimStart ?? 0) + splitOffset,
               trimEnd: originalTrimEnd,
               fadeIn: 0,
               fadeOut: originalFadeOut,
               crossfadePrev: 0,
            });
            track.items.sort((a, b) => a.position - b.position);
            state.modified = true;
            state.playback.previewStale = true;
         });
      },

      play: () => {
         set((s: StudioStore) => {
            s.playback.playing = true;
         });
      },
      pause: () => {
         set((s: StudioStore) => {
            s.playback.playing = false;
         });
      },
      stop: () => {
         set((s: StudioStore) => {
            s.playback.playing = false;
            // Stop returns to the start of whatever was playing — the preview
            // region if one is active, otherwise the beginning — rather than
            // silently dropping out of a preview back into the whole source.
            s.playback.playhead = s.playback.previewStart ?? 0;
         });
      },
      seek: (time: number) => {
         set((s: StudioStore) => {
            s.playback.playhead = time;
         });
      },
      setVolume: (v: number) => {
         set((s: StudioStore) => {
            s.playback.volume = Math.max(0, Math.min(1, v));
         });
      },
      setMuted: (m: boolean) => {
         set((s: StudioStore) => {
            s.playback.muted = m;
         });
      },
      setPlaybackRate: (r: number) => {
         set((s: StudioStore) => {
            s.playback.playbackRate = Math.max(0.25, Math.min(2.0, r));
         });
      },

      previewClip: async (clipId: string) => {
         const state = get();
         const clip = state.project?.clips.find((c) => c.id === clipId);
         if (!clip) return;
         const src = state.project?.sources.find((s) => s.id === clip.sourceId);
         if (!src) return;

         // Load the clip's source waveform if it isn't already cached — mirrors
         // selectSource's loading path but does NOT go through the public
         // selectSource action, which unconditionally clears previewingClipId
         // (that clearing is exactly right when a user manually picks a
         // source, but would immediately erase the label we're about to set).
         set((s: StudioStore) => {
            if (s.selection.selectedSourceId !== clip.sourceId) {
               s.selection.selectedSourceWaveform = s.waveformCache[clip.sourceId] ?? null;
            }
            s.selection.selectedSourceId = clip.sourceId;
            s.playback.mode = "source";
            s.playback.sourcePlaybackPath = src.path;
         });
         await get().getSourceWaveform(clip.sourceId);

         set((s: StudioStore) => {
            s.selection.selectionStart = clip.start;
            s.selection.selectionEnd = clip.end;
            s.selection.selectedClipId = clipId;
            s.playback.previewingClipId = clipId;
            // The bounds are what actually stops playback at the clip's end —
            // the waveform selection is only the visual echo of them.
            s.playback.previewStart = clip.start;
            s.playback.previewEnd = clip.end;
            s.playback.playhead = clip.start;
            s.playback.playing = true;
         });
      },

      previewSelection: () => {
         set((s: StudioStore) => {
            const { selectionStart, selectionEnd } = s.selection;
            if (selectionStart === null || selectionEnd === null) return;
            s.playback.mode = "source";
            s.playback.previewingClipId = "__selection__";
            s.playback.previewStart = selectionStart;
            s.playback.previewEnd = selectionEnd;
            s.playback.playhead = selectionStart;
            s.playback.playing = true;
         });
      },

      playFullSource: () => {
         set((s: StudioStore) => {
            s.playback.mode = "source";
            s.playback.previewingClipId = null;
            s.playback.previewStart = null;
            s.playback.previewEnd = null;
            s.playback.looping = false;
            s.playback.playing = true;
         });
      },

      toggleLoop: () => {
         set((s: StudioStore) => {
            const next = !s.playback.looping;
            s.playback.looping = next;
            // Looping is only meaningful over a region. Turning it on with a
            // selection present adopts that selection as the loop, so the
            // button does what its label promises instead of quietly needing
            // Preview to be pressed first.
            if (next && s.playback.previewEnd === null) {
               const { selectionStart, selectionEnd } = s.selection;
               if (selectionStart !== null && selectionEnd !== null) {
                  s.playback.previewingClipId = "__selection__";
                  s.playback.previewStart = selectionStart;
                  s.playback.previewEnd = selectionEnd;
               }
            }
         });
      },

      renderPreview: async () => {
         const state = get();
         if (!state.project || state.previewRendering) return;
         try {
            set((s: StudioStore) => {
               s.previewRendering = true;
               s.playback.previewStale = true;
               s.playback.mode = "timeline"; // Switch to timeline mode for preview
               // The timeline mix is the whole arrangement; a source-domain
               // clip region must never be left bounding it (the playhead is
               // in composition time now, so those bounds are meaningless).
               s.playback.previewingClipId = null;
               s.playback.previewStart = null;
               s.playback.previewEnd = null;
               s.playback.looping = false;
               s.playback.playing = false;
            });
            const result = await studioApi.renderPreview(state.project);
            set((s: StudioStore) => {
               s.playback.previewPath = assetUrl(result.path);
               s.playback.previewStale = false;
               s.playback.playhead = 0; // Reset playhead
               s.previewRendering = false;
            });
         } catch (e) {
            // Leave the preview marked stale: that keeps "Update Preview" on
            // screen as the retry, instead of pretending the mix is current.
            set((s: StudioStore) => {
               s.playback.previewStale = true;
               s.previewRendering = false;
            });
            toast("Couldn't render the timeline preview", errorMessage(e), "destructive");
         }
      },

      exportMix: async (
         outputPath: string,
         format: string,
         bitrateKbps: number,
      ) => {
         const state = get();
         if (!state.project) return null;
         try {
            return await studioApi.exportMix(
               state.project,
               outputPath,
               format,
               bitrateKbps,
            );
         } catch (e) {
            // Returning null here used to collapse every failure into a
            // generic "Export failed"; the caller now gets the real reason.
            throw new Error(errorMessage(e));
         }
      },

      exportClip: async (
         clipId: string,
         outputPath: string,
         format: string,
         bitrateKbps: number,
      ) => {
         const state = get();
         if (!state.project) return null;
         const clip = state.project.clips.find((c) => c.id === clipId);
         if (!clip) return null;
         const src = state.project.sources.find((s) => s.id === clip.sourceId);
         if (!src) return null;
         try {
            return await studioApi.exportClip(
               src.path,
               clip.start,
               clip.end,
               outputPath,
               format,
               bitrateKbps,
            );
         } catch (e) {
            throw new Error(errorMessage(e));
         }
      },

      undo: () => {
         set((state: StudioStore) => {
            if (state.past.length === 0 || !state.project) return;
            // The redo stack is the current project prepended onto whatever
            // was ALREADY there — not a slice of `past` (unrelated, older
            // states). Getting this wrong means a second consecutive redo
            // (with no new undo in between) silently reverts to the wrong
            // state instead of being the no-op `canRedo()` implies.
            state.future = [state.project, ...state.future].slice(0, HISTORY_LIMIT);
            state.project = JSON.parse(
               JSON.stringify(state.past[state.past.length - 1]),
            );
            state.past = state.past.slice(0, -1);
            state.modified = true;
            afterHistoryJump(state);
         });
      },

      redo: () => {
         set((state: StudioStore) => {
            if (state.future.length === 0 || !state.project) return;
            state.past = [...state.past, state.project].slice(-HISTORY_LIMIT);
            state.project = JSON.parse(JSON.stringify(state.future[0]));
            state.future = state.future.slice(1);
            state.modified = true;
            afterHistoryJump(state);
         });
      },

      canUndo: () => get().past.length > 0,
      canRedo: () => get().future.length > 0,

      setSelectionStart: (time: number | null) => {
         set((s: StudioStore) => {
            s.selection.selectionStart = time;
         });
      },
      setSelectionEnd: (time: number | null) => {
         set((s: StudioStore) => {
            s.selection.selectionEnd = time;
         });
      },
      setSelectedClip: (id: string | null) => {
         set((s: StudioStore) => {
            s.selection.selectedClipId = id;
         });
      },
      setSelectedTrack: (id: string | null) => {
         set((s: StudioStore) => {
            s.selection.selectedTrackId = id;
         });
      },
      setSelectedItem: (trackId: string | null, index: number | null) => {
         set((s: StudioStore) => {
            s.selection.selectedItemTrackId = trackId;
            s.selection.selectedItemIndex = index;
         });
      },

      getMissingSources: async () => {
         const state = get();
         if (!state.project) return [];
         try {
            return await studioApi.missingSources(state.project);
         } catch (e) {
            console.error("Missing sources check failed:", e);
            return [];
         }
      },
   })),
);

// ---- Shared entry points ----------------------------------------------------

/** Audio formats the Studio imports (matches the Import dialog's filter). */
export const AUDIO_EXTENSIONS = ["mp3", "wav", "flac", "m4a", "aac", "ogg"] as const;

/** True when the path ends in one of {@link AUDIO_EXTENSIONS} (case-insensitive). */
export function isAudioPath(path: string): boolean {
   const name = path.split(/[\\/]/).pop() ?? "";
   const dot = name.lastIndexOf(".");
   if (dot <= 0) return false;
   const ext = name.slice(dot + 1).toLowerCase();
   return (AUDIO_EXTENSIONS as readonly string[]).includes(ext);
}

/** Split dropped/picked paths into importable audio files and everything else. */
export function partitionAudioPaths(paths: string[]): { audio: string[]; rejected: string[] } {
   const audio: string[] = [];
   const rejected: string[] = [];
   for (const p of paths) (isAudioPath(p) ? audio : rejected).push(p);
   return { audio, rejected };
}

function fileName(path: string): string {
   return path.split(/[\\/]/).pop() || path;
}

/**
 * Import audio files into the open project, toasting every failure with its
 * real reason (they used to reach only the console). Resolves with the ids of
 * the sources that were added.
 */
export async function importAudioFiles(paths: string[]): Promise<string[]> {
   const added: string[] = [];
   for (const path of paths) {
      try {
         added.push(await useStudioStore.getState().addSource(path));
      } catch (e) {
         toast(`Couldn't import ${fileName(path)}`, errorMessage(e), "destructive");
      }
   }
   return added;
}

/**
 * The one way into the Studio from elsewhere in the app (Downloads, History):
 * make sure a project exists, add the file (or reuse it if it's already a
 * source), select it so its waveform shows, switch to the Studio, and say
 * what happened either way.
 */
export async function openInStudio(path: string, title?: string | null): Promise<boolean> {
   try {
      const store = useStudioStore.getState();
      if (!store.project) await store.newProject("Untitled Mix");
      const existing = useStudioStore.getState().project?.sources.find((s) => s.path === path);
      const id = existing ? existing.id : await useStudioStore.getState().addSource(path);
      useAppStore.getState().setView("studio");
      // The waveform loads in the background; its failure shows inline.
      void useStudioStore.getState().selectSource(id);
      toast(
         existing ? "Already in Audio Studio" : "Opened in Audio Studio",
         title || fileName(path),
         "success",
      );
      return true;
   } catch (e) {
      toast("Couldn't open in Audio Studio", errorMessage(e), "destructive");
      return false;
   }
}
