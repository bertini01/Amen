import { test, expect } from "./e2e-fixtures";

test("connects to the real running Wavecrate app and opens Audio Studio", async ({ page }) => {
   await expect(page).toHaveTitle(/Wavecrate/i, { timeout: 15000 });
   const hasTauri = await page.evaluate(() => typeof (window as any).__TAURI_INTERNALS__ !== "undefined");
   expect(hasTauri, "window.__TAURI_INTERNALS__ must exist — this must be the real app, not a plain browser").toBe(true);

   await page.getByText("Audio Studio").click();
   await page.waitForTimeout(500);
   const studioVisible = await page.locator("text=Create something new").isVisible().catch(() => false);
   const timelineVisible = await page.locator("text=Timeline").first().isVisible().catch(() => false);
   expect(studioVisible || timelineVisible).toBe(true);
});
