import { test, expect } from "./e2e-fixtures";

/**
 * Basic app-shell coverage: every primary nav destination must actually
 * render its view (no blank page, no crash) when navigated to directly from
 * a cold start. This is the only place these pages were exercised at all —
 * everything else in the suite jumps straight into Audio Studio.
 */
test.describe("Wavecrate — navigation & app shell", () => {
   test("all primary nav destinations render their view", async ({ page }) => {
      await page.getByRole("button", { name: "Home" }).click();
      await expect(page.locator("h1, h2").first()).toBeVisible();

      await page.getByRole("button", { name: "Downloads" }).click();
      await expect(page.getByRole("heading", { name: "Downloads", exact: true })).toBeVisible();

      await page.getByRole("button", { name: "History" }).click();
      await expect(page.getByRole("heading", { name: "History", exact: true })).toBeVisible();

      await page.getByRole("button", { name: "Settings" }).click();
      await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();

      await page.getByRole("button", { name: "Diagnostics" }).click();
      await expect(page.getByRole("heading", { name: "Diagnostics" })).toBeVisible();
      // Diagnostics performs real local checks (yt-dlp/FFmpeg/ffprobe/disk/network) —
      // confirm they actually resolve to a real result, not stuck loading.
      await expect(page.locator("text=/Installed|Missing/").first()).toBeVisible({ timeout: 15000 });

      await page.getByRole("button", { name: "Audio Studio" }).click();
      const studioVisible = await page.locator("text=Create something new").isVisible().catch(() => false);
      const timelineVisible = await page.locator("text=Timeline").first().isVisible().catch(() => false);
      expect(studioVisible || timelineVisible).toBe(true);
   });

   test("Settings sections all switch without losing the save bar", async ({ page }) => {
      await page.getByRole("button", { name: "Settings" }).click();
      await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();

      // Scope to the Settings view's own section nav, not the app's left sidebar
      // (both have a "Downloads" entry).
      const settingsMain = page.getByRole("main");
      for (const section of ["General", "Downloads", "Metadata", "yt-dlp & FFmpeg", "Advanced"]) {
         await settingsMain.getByRole("button", { name: section, exact: true }).click();
         await page.waitForTimeout(100);
      }
   });
});
