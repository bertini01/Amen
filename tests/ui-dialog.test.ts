import { beforeEach, describe, expect, it } from "vitest";
import { appChoose, appConfirm, useUiDialogStore } from "@/stores/uiDialog";
import { describePlaybackError } from "@/components/PlayerBar";

describe("uiDialog store", () => {
   beforeEach(() => useUiDialogStore.setState({ request: null }));

   it("passes confirm options through to the host", () => {
      void appConfirm("Clear everything?", { title: "Clear history?", confirmLabel: "Clear", destructive: true });
      expect(useUiDialogStore.getState().request).toMatchObject({
         kind: "confirm",
         title: "Clear history?",
         confirmLabel: "Clear",
         destructive: true,
      });
   });

   it("settles a replaced request as dismissed instead of leaving it hanging", async () => {
      const first = appConfirm("First?");
      void appChoose("Second", [{ id: "open", label: "Open", primary: true }]);
      await expect(first).resolves.toBe(false);
      expect(useUiDialogStore.getState().request?.kind).toBe("choice");
   });

   it("resolves a choice with the picked id", async () => {
      const pending = appChoose("Export complete", [
         { id: "reveal", label: "Show in folder" },
         { id: "open", label: "Open file", primary: true },
      ]);
      const req = useUiDialogStore.getState().request;
      if (req?.kind !== "choice") throw new Error("expected a choice dialog");
      expect(req.cancelLabel).toBe("Close");
      req.resolve("reveal");
      await expect(pending).resolves.toBe("reveal");
   });
});

describe("describePlaybackError", () => {
   it("explains unloadable sources", () => {
      expect(describePlaybackError({ name: "NotSupportedError", message: "x" })).toMatch(/couldn't be loaded/);
   });

   it("explains blocked playback", () => {
      expect(describePlaybackError({ name: "NotAllowedError", message: "x" })).toMatch(/blocked/);
   });

   it("falls back to the error's own message", () => {
      expect(describePlaybackError(new Error("decode failed"))).toBe("decode failed");
   });
});
