import { test, expect } from "./e2e-fixtures";
import {
   resizeWindow,
   importSource,
   selectSource,
   selectWaveformRegion,
   dragClipToTrack,
   resetToNewProject,
   FIXTURES,
} from "./e2e-fixtures";

/**
 * Real native-window resize (via `core:window:allow-set-size`, see
 * `resizeWindow` in e2e-fixtures.ts) — NOT Playwright's `setViewportSize`,
 * which only emulates viewport metrics over CDP and does not remap this
 * app's real mouse-input coordinates. This actually resizes the OS window,
 * so both rendering AND input behave exactly as they would for a real user
 * resizing the app.
 *
 * The sandboxed test display here is 1600×900, so sizes at or below that are
 * verified for real. Anything larger cannot be genuinely rendered on this
 * physical screen and is not claimed as tested.
 */
const SIZES: Array<{ w: number; h: number; label: string }> = [
   { w: 1280, h: 720, label: "1280x720" },
   { w: 1366, h: 768, label: "1366x768" },
   { w: 1600, h: 900, label: "1600x900" },
];

/** No horizontal overflow anywhere in the page — the #1 responsive-layout failure mode. */
async function assertNoHorizontalOverflow(page: import("@playwright/test").Page, context: string) {
   const overflow = await page.evaluate(() => {
      const de = document.documentElement;
      return { scrollWidth: de.scrollWidth, clientWidth: de.clientWidth };
   });
   expect(
      overflow.scrollWidth,
      `${context}: page must not overflow horizontally (scrollWidth=${overflow.scrollWidth} vs clientWidth=${overflow.clientWidth})`,
   ).toBeLessThanOrEqual(overflow.clientWidth + 2); // +2px rounding tolerance
}

test.describe("Amply Studio — responsive behavior at real desktop window sizes", () => {
   test.afterAll(async ({ page }) => {
      // Leave the window at its default configured size for other tests.
      await resizeWindow(page, 1280, 840);
   });

   for (const size of SIZES) {
      test(`${size.label}: Home, Downloads, History, Settings, Diagnostics have no horizontal overflow or clipped controls`, async ({ page }) => {
         await resizeWindow(page, size.w, size.h);

         await page.getByRole("button", { name: "Home" }).click();
         await page.waitForTimeout(150);
         await assertNoHorizontalOverflow(page, `${size.label} Home`);

         await page.getByRole("button", { name: "Downloads" }).click();
         await page.waitForTimeout(150);
         await assertNoHorizontalOverflow(page, `${size.label} Downloads`);

         await page.getByRole("button", { name: "History" }).click();
         await page.waitForTimeout(150);
         await assertNoHorizontalOverflow(page, `${size.label} History`);

         await page.getByRole("button", { name: "Settings" }).click();
         await page.waitForTimeout(150);
         await assertNoHorizontalOverflow(page, `${size.label} Settings`);
         // The save bar must stay reachable, not clipped off the bottom/side.
         await expect(page.getByRole("button", { name: "Save changes" })).toBeVisible();

         await page.getByRole("button", { name: "Diagnostics" }).click();
         await page.waitForTimeout(150);
         await assertNoHorizontalOverflow(page, `${size.label} Diagnostics`);
         await expect(page.getByRole("button", { name: "Copy report" })).toBeVisible();

         await page.screenshot({ path: `test-results/responsive-${size.label}-diagnostics.png` });
      });

      test(`${size.label}: Audio Studio timeline, waveform, and transport remain usable — no clipped controls, drag/drop still works`, async ({ page }) => {
         await resizeWindow(page, size.w, size.h);
         await page.getByRole("button", { name: "Audio Studio" }).click();
         await page.waitForTimeout(300);
         await resetToNewProject(page);

         await importSource(page, FIXTURES.a.path);
         await selectSource(page, FIXTURES.a.name);
         await assertNoHorizontalOverflow(page, `${size.label} Studio (source loaded)`);

         await selectWaveformRegion(page, 0.1, 0.5);
         await page.getByRole("button", { name: "Create Clip", exact: true }).click();
         await page.waitForTimeout(150);
         await expect(page.locator('[data-testid="clip-item"]')).toHaveCount(1);

         // Drag/drop must still work correctly at this window size — this is
         // exactly the interaction `setViewportSize` could not validate.
         await dragClipToTrack(page, FIXTURES.a.name, 0, 0.1);
         await expect(page.locator('[data-testid="timeline-clip"]')).toHaveCount(1);

         // The transport bar and its controls must be fully visible, not
         // squeezed off-screen at the narrower widths.
         const playBtn = page.locator('button[title="Stop (resets to 0)"]').locator("..").locator("button").nth(1);
         await expect(playBtn).toBeVisible();
         const exportBtn = page.getByRole("button", { name: "Export", exact: true });
         await expect(exportBtn).toBeVisible();

         await assertNoHorizontalOverflow(page, `${size.label} Studio (with timeline clip)`);
         await page.screenshot({ path: `test-results/responsive-${size.label}-studio.png` });
      });
   }
});
