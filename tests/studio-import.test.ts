import { beforeEach, describe, expect, it, vi } from "vitest";

// The Tauri bridge is the only thing mocked: probe/waveform calls resolve
// with canned data so the store logic itself runs for real.
vi.mock("@/lib/api", () => ({
   studioApi: {
      probeAudio: vi.fn(async () => ({ duration: 12, sampleRate: 44100, channels: 2 })),
      waveform: vi.fn(async () => ({ duration: 12, peaks: [] })),
   },
   api: {
      getAppInfo: vi.fn(),
      detectDependencies: vi.fn(),
   },
   assetUrl: (p: string) => p,
}));

import { studioApi } from "@/lib/api";
import {
   isAudioPath,
   partitionAudioPaths,
   openInStudio,
   importAudioFiles,
   useStudioStore,
} from "@/stores/studio";
import { useAppStore } from "@/stores/app";
import { useToastStore } from "@/stores/toast";

describe("isAudioPath", () => {
   it("accepts the supported audio extensions, case-insensitively", () => {
      expect(isAudioPath("C:\\Music\\song.mp3")).toBe(true);
      expect(isAudioPath("C:\\Music\\SONG.WAV")).toBe(true);
      expect(isAudioPath("/home/me/a.flac")).toBe(true);
      expect(isAudioPath("x.m4a")).toBe(true);
      expect(isAudioPath("x.aac")).toBe(true);
      expect(isAudioPath("x.Ogg")).toBe(true);
   });

   it("rejects video, documents, folders and extension-less names", () => {
      expect(isAudioPath("C:\\Videos\\clip.mp4")).toBe(false);
      expect(isAudioPath("notes.txt")).toBe(false);
      expect(isAudioPath("C:\\Music\\Album")).toBe(false);
      expect(isAudioPath("C:\\Music\\.mp3")).toBe(false); // dot-file, no name
      expect(isAudioPath("C:\\mp3\\readme")).toBe(false); // extension is in the folder, not the file
   });
});

describe("partitionAudioPaths", () => {
   it("splits a mixed drop into importable audio and the rest, preserving order", () => {
      const { audio, rejected } = partitionAudioPaths([
         "a.mp3",
         "b.mp4",
         "c.wav",
         "d.txt",
      ]);
      expect(audio).toEqual(["a.mp3", "c.wav"]);
      expect(rejected).toEqual(["b.mp4", "d.txt"]);
   });

   it("handles an empty drop", () => {
      expect(partitionAudioPaths([])).toEqual({ audio: [], rejected: [] });
   });
});

describe("openInStudio", () => {
   beforeEach(() => {
      useStudioStore.setState({ project: null, waveformCache: {}, waveformError: null, waveformLoadingId: null });
      useAppStore.setState({ view: "downloads" });
      useToastStore.setState({ toasts: [] });
      vi.mocked(studioApi.probeAudio).mockClear();
   });

   it("adds the file even when no Studio project exists yet, selects it and navigates", async () => {
      const ok = await openInStudio("C:\\Music\\song.mp3", "My Song");
      expect(ok).toBe(true);
      const { project, selection } = useStudioStore.getState();
      expect(project).not.toBeNull();
      expect(project!.sources).toHaveLength(1);
      expect(project!.sources[0].path).toBe("C:\\Music\\song.mp3");
      expect(selection.selectedSourceId).toBe(project!.sources[0].id);
      expect(useAppStore.getState().view).toBe("studio");
      expect(useToastStore.getState().toasts.at(-1)).toMatchObject({
         title: "Opened in Audio Studio",
         variant: "success",
      });
   });

   it("reuses an already-imported source instead of duplicating it", async () => {
      await openInStudio("C:\\Music\\song.mp3");
      await openInStudio("C:\\Music\\song.mp3");
      expect(useStudioStore.getState().project!.sources).toHaveLength(1);
      expect(studioApi.probeAudio).toHaveBeenCalledTimes(1);
   });

   it("reports the real failure and stays put when the file can't be probed", async () => {
      vi.mocked(studioApi.probeAudio).mockRejectedValueOnce({
         code: "io",
         message: "File not found",
         detail: null,
      });
      const ok = await openInStudio("C:\\gone.mp3");
      expect(ok).toBe(false);
      expect(useAppStore.getState().view).toBe("downloads");
      expect(useToastStore.getState().toasts.at(-1)).toMatchObject({
         title: "Couldn't open in Audio Studio",
         description: "File not found",
         variant: "destructive",
      });
   });
});

describe("importAudioFiles", () => {
   beforeEach(() => {
      useStudioStore.setState({ project: null });
      useToastStore.setState({ toasts: [] });
   });

   it("imports what it can and toasts each failure with its reason", async () => {
      vi.mocked(studioApi.probeAudio)
         .mockResolvedValueOnce({ duration: 1, sampleRate: 44100, channels: 2 } as never)
         .mockRejectedValueOnce({ code: "probe", message: "Unsupported codec", detail: null });
      const added = await importAudioFiles(["ok.wav", "bad.ogg"]);
      expect(added).toHaveLength(1);
      expect(useStudioStore.getState().project!.sources.map((s) => s.name)).toEqual(["ok.wav"]);
      expect(useToastStore.getState().toasts.at(-1)).toMatchObject({
         title: "Couldn't import bad.ogg",
         description: "Unsupported codec",
      });
   });
});
