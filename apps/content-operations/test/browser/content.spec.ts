import { expect, test, type Page } from "@playwright/test";

async function fit(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  for (const button of await page.getByRole("button").all()) {
    if (await button.isVisible())
      expect(
        await button.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
      ).toBe(true);
  }
}
test("workbench filters, board, paging, empty states and draft creation/editing", async ({
  page,
}, info) => {
  // First navigation includes cold dependency optimization as well as the full workflow.
  test.setTimeout(60_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/content?limit=2");
  await expect(page.getByRole("heading", { name: "Content", exact: true })).toBeVisible();
  await expect(page.getByText("2 items loaded")).toBeVisible();
  await page.getByRole("button", { name: "Load more", exact: true }).click();
  await expect(page.getByText("4 items loaded")).toBeVisible();
  await page.getByRole("button", { name: "Board view", exact: true }).click();
  await expect(page.getByText("4 items loaded")).toBeVisible();
  await fit(page);
  await page.screenshot({ path: info.outputPath("board.png"), fullPage: true });
  await page.getByRole("button", { name: "List view", exact: true }).click();
  await page.getByRole("textbox", { name: "Search title" }).fill("nothing-matches-this-query");
  await page.getByRole("button", { name: "Apply filters" }).click();
  await expect(page.getByRole("heading", { name: "No matching content" })).toBeVisible();
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(page.getByText("Release notes: draft", { exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath("list.png"), fullPage: true });
  await page.getByRole("link", { name: "New content", exact: true }).click();
  await page.getByLabel("Title", { exact: true }).fill(`Browser draft ${info.project.name}`);
  await page.getByLabel("Body", { exact: true }).fill("First line\nSecond line");
  await page.getByRole("button", { name: "Create content", exact: true }).click();
  await expect(page).toHaveURL(/\/content\/[a-f0-9-]{36}$/);
  await page.getByLabel("Body", { exact: true }).fill("Edited body\nwith preserved whitespace. ");
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  await fit(page);
  await page.screenshot({ path: info.outputPath("editor.png"), fullPage: true });
  await page.reload();
  await expect(page.getByLabel("Body", { exact: true })).toHaveValue(
    "Edited body\nwith preserved whitespace. ",
  );
  await page.getByLabel("Fixture identity").selectOption("author_2");
  await expect(page.getByLabel("Title", { exact: true })).toBeDisabled();
  await expect(
    page.getByText("Only the owning author or an editor can edit this draft."),
  ).toBeVisible();
  await page.getByLabel("Fixture identity").selectOption("editor_1");
  await expect(page.getByLabel("Title", { exact: true })).toBeEnabled();
  await page.getByLabel("Title", { exact: true }).fill("W".repeat(160));
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(page.getByRole("heading", { name: "W".repeat(160) })).toBeVisible();
  await fit(page);
  await page.screenshot({ path: info.outputPath("long-title.png"), fullPage: true });
  expect(errors).toEqual([]);
});
test("conflicts never overwrite local drafts and navigation/fixture changes require consent", async ({
  page,
}, info) => {
  const response = await page.request.post("/api/resources/contentItem/commands/create", {
    headers: { "x-content-ops-fixture": "author_1" },
    data: {
      input: { title: `Conflict ${info.project.name}`, body: "Initial" },
      idempotencyKey: crypto.randomUUID(),
    },
  });
  const { data } = await response.json();
  await page.goto(`/content/${data.resourceId}`);
  await page.getByLabel("Body", { exact: true }).fill("Retained local draft");
  const update = await page.request.post(
    `/api/resources/contentItem/${data.resourceId}/commands/editDraft`,
    {
      headers: { "x-content-ops-fixture": "author_1" },
      data: {
        input: { expectedVersion: 1, title: "Remote title", body: "Remote text" },
        idempotencyKey: crypto.randomUUID(),
      },
    },
  );
  expect(update.ok()).toBe(true);
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Your draft is preserved");
  await expect(page.getByLabel("Body", { exact: true })).toHaveValue("Retained local draft");
  await page.getByRole("button", { name: "Compare latest" }).click();
  await expect(page.getByRole("heading", { name: "Server version 2" })).toBeVisible();
  await page.getByRole("button", { name: "Keep local draft" }).click();
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  await page.getByLabel("Body", { exact: true }).fill("Unsaved work");
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("link", { name: "Back to content", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(data.resourceId));
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByLabel("Fixture identity").selectOption("author_2");
  await expect(page.getByLabel("Fixture identity")).toHaveValue("author_1");
  await expect(page.getByLabel("Body", { exact: true })).toHaveValue("Unsaved work");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("link", { name: "Back to content", exact: true }).click();
  await expect(page).toHaveURL(/\/content$/);
});
test("direct URL filters reload and preserve return navigation; invalid filters fail safely", async ({
  page,
}) => {
  await page.goto("/content?status=draft&authorId=author_1&title=Release&view=board");
  await expect(page.getByRole("combobox", { name: "Status filter" })).toHaveValue("draft");
  await expect(page.getByRole("button", { name: "Board view" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.getByRole("link", { name: /Release notes: draft/ }).click();
  await page.getByRole("link", { name: "Back to content", exact: true }).click();
  await expect(page).toHaveURL(/status=draft.*authorId=author_1.*title=Release.*view=board/);
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Search title" })).toHaveValue("Release");
  await page.goto("/content?limit=999");
  await expect(page.getByRole("alert")).toContainText("filters are invalid");
  await fit(page);
});
