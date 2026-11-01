import { expect, test, type Page, type APIRequestContext } from "@playwright/test";

async function command(
  request: APIRequestContext,
  name: string,
  id: string | undefined,
  input: unknown,
  actor = "author_1",
) {
  const response = await request.post(
    `/api/resources/contentItem/${id ? `${id}/` : ""}commands/${name}`,
    {
      headers: { "x-content-ops-fixture": actor },
      data: { input, idempotencyKey: crypto.randomUUID() },
    },
  );
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).data;
}
async function content(request: APIRequestContext, id: string) {
  return (
    await (
      await request.get(`/api/resources/contentItem/${id}`, {
        headers: { "x-content-ops-fixture": "author_1" },
      })
    ).json()
  ).data.resource;
}
async function fits(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}
test("author to editor changes, revised submission, approval, immutable history and paged activity", async ({
  page,
}, info) => {
  test.setTimeout(60_000);
  const title = `Editorial cycle ${info.project.name}`;
  const created = await command(page.request, "create", undefined, {
    title,
    body: "Original submitted body",
  });
  await page.goto(`/content/${created.resourceId}`);
  await page.getByLabel("Assigned editor", { exact: true }).selectOption("editor_2");
  await page.getByLabel("Review due (UTC)").fill("2020-01-01T00:00");
  await page.getByRole("button", { name: "Submit for review", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("future review due time");
  await page
    .getByLabel("Review due (UTC)")
    .fill(new Date(Date.now() + 86400000).toISOString().slice(0, 16));
  await page.getByRole("button", { name: "Submit for review", exact: true }).click();
  await expect(page.getByRole("link", { name: "Open review", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Open review", exact: true })).toBeFocused();
  const first = (await content(page.request, created.resourceId)).state.review;
  await page.getByRole("link", { name: "Open review", exact: true }).click();
  await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve", exact: true })).toHaveCount(0);
  await page.getByLabel("Fixture identity").selectOption("editor_2");
  await expect(page.getByLabel("Decision note")).toBeVisible();
  await page.getByRole("button", { name: "Request changes", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("decision note");
  await expect(page.getByLabel("Decision note")).toBeFocused();
  await page.getByLabel("Decision note").fill("Clarify the final paragraph.");
  await fits(page);
  await page.screenshot({ path: info.outputPath("review-decision.png"), fullPage: true });
  await page.getByRole("button", { name: "Request changes", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Recorded decision" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Recorded decision" })).toBeFocused();
  await page.getByRole("link", { name: "Current content", exact: true }).click();
  await page.getByLabel("Fixture identity").selectOption("author_1");
  await page.getByLabel("Body", { exact: true }).fill("Revised submitted body");
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Submit for review", exact: true }).click();
  await expect
    .poll(async () => (await content(page.request, created.resourceId)).state.status)
    .toBe("inReview");
  await page.getByRole("link", { name: "Open review", exact: true }).click();
  await expect(page.getByRole("region", { name: "Submitted snapshot" })).toContainText(
    "Revised submitted body",
  );
  await page.getByLabel("Fixture identity").selectOption("editor_1");
  await page.getByLabel("Decision note").fill("Approved the revised snapshot.");
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Recorded decision" })).toBeVisible();
  expect((await content(page.request, created.resourceId)).state.status).toBe("approved");
  await page.getByRole("button", { name: "Load more activity", exact: true }).click();
  await expect(page.getByRole("region", { name: "Activity" })).toContainText("Created draft");
  await expect(page.getByRole("region", { name: "Activity" }).getByRole("listitem")).toHaveCount(6);
  await expect(page.getByRole("region", { name: "Activity" })).toContainText("Approved content");
  await fits(page);
  await page.screenshot({ path: info.outputPath("approved-review.png"), fullPage: true });
  await page.goto(`/reviews?contentId=${created.resourceId}&status=all&limit=1`);
  await expect(page.getByLabel("Fixture identity")).toHaveValue("editor_1");
  await expect(page.getByText("1 review loaded", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Load more reviews", exact: true }).click();
  await expect(page.getByText("2 reviews loaded", { exact: true })).toBeVisible();
  await page.getByLabel("Review assignment").selectOption("editor_2");
  await expect(page).toHaveURL(/editorId=editor_2/);
  await page.getByLabel("Overdue only").check();
  await expect(page.getByRole("heading", { name: "No matching reviews" })).toBeVisible();
  await page.getByLabel("Overdue only").uncheck();
  await expect(page.getByRole("link", { name: title, exact: true })).toBeVisible();
  await fits(page);
  await page.screenshot({ path: info.outputPath("review-queue.png"), fullPage: true });
  await page.goto(`/reviews/${first.reviewId}?contentId=${created.resourceId}`);
  await expect(page.getByRole("region", { name: "Submitted snapshot" })).toContainText(
    "Original submitted body",
  );
  await expect(page.getByText("Clarify the final paragraph.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve", exact: true })).toHaveCount(0);
});
test("a stale review cannot approve a reopened revision and the decision note survives refresh", async ({
  page,
}, info) => {
  const created = await command(page.request, "create", undefined, {
    title: `Stale review ${info.project.name}`,
    body: "Frozen before reopen",
  });
  await command(page.request, "submit", created.resourceId, {
    expectedVersion: 1,
    assignedEditorId: "editor_1",
    dueAt: new Date(Date.now() + 86400000).toISOString(),
  });
  const first = (await content(page.request, created.resourceId)).state.review;
  await page.goto(`/reviews/${first.reviewId}?contentId=${created.resourceId}`);
  await page.getByLabel("Fixture identity").selectOption("editor_1");
  await page.getByLabel("Decision note").fill("Stale note retained");
  await command(page.request, "reopenDraft", created.resourceId, { expectedVersion: 2 });
  await command(page.request, "editDraft", created.resourceId, {
    expectedVersion: 3,
    title: "Replacement revision",
    body: "Replacement body",
  });
  await command(page.request, "submit", created.resourceId, {
    expectedVersion: 4,
    assignedEditorId: "editor_2",
    dueAt: new Date(Date.now() + 86400000).toISOString(),
  });
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("input is preserved");
  await expect(page.getByLabel("Decision note")).toHaveValue("Stale note retained");
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByLabel("Fixture identity").selectOption("author_2");
  await expect(page.getByLabel("Fixture identity")).toHaveValue("editor_1");
  await page.getByRole("button", { name: "Refresh review", exact: true }).click();
  await expect(
    page.getByText("Historical review · not the current submitted revision"),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve", exact: true })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Submitted snapshot" })).toContainText(
    "Frozen before reopen",
  );
  expect((await content(page.request, created.resourceId)).state.status).toBe("inReview");
  await expect(page.getByLabel("Unrecorded decision note")).toHaveValue("Stale note retained");
  await fits(page);
  await page.getByRole("button", { name: "Discard note", exact: true }).click();
  await expect(page.getByLabel("Unrecorded decision note")).toHaveCount(0);
});
