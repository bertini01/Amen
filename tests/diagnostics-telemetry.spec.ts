import { test, expect } from "./e2e-fixtures";
import { importSource, selectSource, selectWaveformRegion, resetToNewProject, FIXTURES } from "./e2e-fixtures";

test.describe("Diagnostics — real telemetry", () => {
   test("CPU and memory usage charts populate with real, live-updating data", async ({ page }) => {
      await page.getByRole("button", { name: "Diagnostics" }).click();
      await page.waitForTimeout(4000); // real dependency checks + first telemetry samples

      await expect(page.getByText("Wavecrate CPU usage")).toBeVisible();
      await expect(page.getByText("Wavecrate memory usage")).toBeVisible();

      // The percent/MB readouts must show real numbers, not placeholders.
      const cpuText = await page.locator("text=Wavecrate CPU usage").locator("../..").locator("span.font-mono").first().textContent();
      expect(cpuText, "CPU readout must show a real percentage, not a placeholder").toMatch(/^\d+(\.\d+)?%$/);

      const memText = await page.locator("text=Wavecrate memory usage").locator("../..").locator("span.font-mono").first().textContent();
      expect(memText, "memory readout must show a real MB value, not a placeholder").toMatch(/^\d+ MB$/);

      // The process actually uses non-zero memory — a real, non-fabricated reading.
      const memMb = parseFloat(memText!.replace(" MB", ""));
      expect(memMb, "Wavecrate's own process must show a real, non-trivial memory footprint").toBeGreaterThan(1);
   });

   test("current Studio project statistics reflect the real, live project state", async ({ page }) => {
      await page.getByText("Audio Studio").click();
      await page.waitForTimeout(300);
      await resetToNewProject(page);
      await importSource(page, FIXTURES.a.path);
      await selectSource(page, FIXTURES.a.name);
      await selectWaveformRegion(page, 0.1, 0.4);
      await page.getByRole("button", { name: "Create Clip", exact: true }).click();
      await page.waitForTimeout(150);

      await page.getByRole("button", { name: "Diagnostics" }).click();
      await page.waitForTimeout(4000);

      await expect(page.getByText("Current Studio project")).toBeVisible();
      const card = page.locator("text=Current Studio project").locator("../..");
      await expect(card.getByText("Sources")).toBeVisible();
      // 1 source, 1 clip — the exact counts from the project just created.
      const sourcesValue = await card.locator("text=Sources").locator("..").locator(".font-mono").textContent();
      expect(sourcesValue?.trim()).toBe("1");
      const clipsValue = await card.locator("text=Clips").locator("..").locator(".font-mono").textContent();
      expect(clipsValue?.trim()).toBe("1");
   });

   test("Diagnostics uses a wide layout, not the old narrow centered column", async ({ page }) => {
      await page.getByRole("button", { name: "Diagnostics" }).click();
      await page.waitForTimeout(300);
      const containerWidth = await page.evaluate(() => {
         const heading = Array.from(document.querySelectorAll("h1")).find((h) => h.textContent === "Diagnostics");
         const container = heading?.closest("div.mx-auto");
         return container?.getBoundingClientRect().width ?? 0;
      });
      // max-w-6xl = 1152px — must be meaningfully wider than the old max-w-3xl (768px).
      expect(containerWidth, "Diagnostics must use a wide layout, not the old cramped centered column").toBeGreaterThan(900);
   });
});
