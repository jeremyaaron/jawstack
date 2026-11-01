import { test, expect, assertLayout } from "./fixtures";

test("keyboard navigation, fixture isolation and all workspace views", async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto("/content?status=draft&view=board&title=Release");
  await expect(page.getByRole("heading", { name: "Content", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Skip to content", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("main")).toBeFocused();
  await page.getByLabel("Fixture identity").selectOption("editor_2");
  for (const name of ["Reviews", "Calendar", "Operations", "Content"]) {
    const link = page
      .getByRole("navigation", { name: "Primary" })
      .getByRole("link", { name, exact: true });
    await link.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
    await expect(page.locator("main")).toBeFocused();
    await assertLayout(page);
  }
  await page.getByRole("link", { name: "New content", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Title", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Create content", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Title", { exact: true })).toBeFocused();
  await page.getByLabel("Fixture identity").selectOption("author_2");
  await page.goto("/operations");
  await expect(page.getByRole("alert")).toContainText("cannot read operations");
  await page.getByLabel("Fixture identity").selectOption("editor_2");
  await expect(page.getByRole("group", { name: "Operations view" })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Fixture identity")).toHaveValue("editor_2");
});
test("query failures are explicit and refresh restores navigation state", async ({ page }) => {
  await page.route("**/api/content?**", (route) => route.abort("connectionfailed"), { times: 1 });
  await page.goto("/content?status=draft&view=board&title=Release");
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByText("No matching content", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Refresh content", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Release notes: draft", exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL(/status=draft.*view=board.*title=Release/);
  await expect(page.getByRole("button", { name: "Board view", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});
