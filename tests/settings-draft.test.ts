import { describe, expect, it } from "vitest";
import { diffSettings } from "@/stores/settings";
import type { AppSettings } from "@/lib/types";

const saved: AppSettings = {
   theme: "dark",
   startupBehavior: "restore",
   defaultFormat: "mp3",
   defaultQuality: "best",
   outputDir: "C:\\Users\\me\\Music",
   filenameTemplate: "%(title)s.%(ext)s",
   overwriteBehavior: "skip",
   duplicateHandling: "skip",
   embedArtwork: true,
   embedMetadata: true,
   ytdlpPath: "",
   ffmpegPath: "",
   ffprobePath: "",
   maxConcurrent: 3,
   clipboardMonitor: false,
   notifyOnComplete: true,
   cookiesFile: "",
};

describe("diffSettings", () => {
   it("is empty when nothing was edited", () => {
      expect(diffSettings(saved, {})).toEqual({});
   });

   it("keeps only the fields that differ from what is saved", () => {
      expect(
         diffSettings(saved, { maxConcurrent: 5, embedArtwork: true, outputDir: "D:\\Downloads" }),
      ).toEqual({ maxConcurrent: 5, outputDir: "D:\\Downloads" });
   });

   it("treats an edit typed back to its saved value as unchanged", () => {
      expect(diffSettings(saved, { filenameTemplate: "%(title)s.%(ext)s" })).toEqual({});
   });

   it("compares against the CURRENT saved settings, so an external save clears the matching edit", () => {
      // e.g. Home's "Browse destination" saved the same folder the draft holds.
      const resaved = { ...saved, outputDir: "D:\\Downloads" };
      expect(diffSettings(resaved, { outputDir: "D:\\Downloads", maxConcurrent: 2 })).toEqual({
         maxConcurrent: 2,
      });
   });

   it("detects falsy changes (false, empty string)", () => {
      expect(diffSettings(saved, { notifyOnComplete: false, outputDir: "" })).toEqual({
         notifyOnComplete: false,
         outputDir: "",
      });
   });
});
