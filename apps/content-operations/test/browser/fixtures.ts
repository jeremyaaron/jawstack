import { expect, test as base, type Page } from "@playwright/test";
export { expect } from "@playwright/test";

export async function assertLayout(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  );
  const clipped = await page
    .locator("button,h1,h2,h3,.calendar-day,.operation-record")
    .evaluateAll((nodes) =>
      nodes
        .filter(
          (node) => node.getClientRects().length && getComputedStyle(node).visibility !== "hidden",
        )
        .filter((node) => node.scrollWidth > node.clientWidth + 1)
        .map((node) => ({
          tag: node.tagName,
          className: node.className,
          text: node.textContent?.trim().slice(0, 80),
        })),
    );
  expect(clipped, "Visible controls/headings must fit their containers").toEqual([]);
  const boxes = await page.locator(".topbar,main").evaluateAll((nodes) =>
    nodes.map((node) => {
      const { top, bottom } = node.getBoundingClientRect();
      return { top, bottom };
    }),
  );
  if (boxes.length === 2) expect(boxes[1]!.top).toBeGreaterThanOrEqual(boxes[0]!.bottom - 1);
}
export const test = base.extend<{ acceptance: void }>({
  acceptance: [
    async ({ page }, use, info) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => {
        if (errors.length < 10) errors.push(error.message.slice(0, 500));
      });
      await use();
      if (
        info.status === info.expectedStatus &&
        page.url().startsWith(String(info.project.use.baseURL))
      ) {
        await assertLayout(page);
        await page.screenshot({ path: info.outputPath("acceptance.png"), fullPage: true });
      }
      expect(errors, "No uncaught browser errors").toEqual([]);
    },
    { auto: true },
  ],
});
