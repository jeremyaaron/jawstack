import { readFile } from "node:fs/promises";
import { test, expect, assertLayout } from "./fixtures";

test("author upload, editor review, automatic scheduled publication and operational outcomes", async ({
  page,
}, info) => {
  test.setTimeout(240_000);
  const runtime = info.config.metadata.runtime as "memory" | "localstack";
  const health = await (await page.request.get("/api/health")).json();
  expect(health.data).toMatchObject({
    runtime,
    processing: runtime === "memory" ? "managed" : "external-workers",
  });
  const title = `Browser workflow ${runtime} ${info.project.name} ${crypto.randomUUID().slice(0, 8)}`;
  await page.goto("/content/new");
  await page.getByLabel("Title", { exact: true }).fill(title);
  await page
    .getByLabel("Body", { exact: true })
    .fill("A frozen publication proved through the browser.");
  await page.getByRole("button", { name: "Create content", exact: true }).click();
  await expect(page).toHaveURL(/\/content\/[a-f0-9-]{36}$/);
  const id = new URL(page.url()).pathname.split("/").at(-1)!;
  const read = async () =>
    (
      await (
        await page.request.get(`/api/resources/contentItem/${id}`, {
          headers: { "x-content-ops-fixture": "author_1" },
        })
      ).json()
    ).data.resource;
  const bitmap = Buffer.from(
    await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 160;
      canvas.height = 80;
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#27765b";
      ctx.fillRect(0, 0, 160, 80);
      ctx.fillStyle = "#f4f7f6";
      ctx.fillRect(12, 12, 80, 12);
      ctx.fillStyle = "#467b9c";
      ctx.fillRect(12, 40, 130, 24);
      const pixels = ctx.getImageData(0, 0, 160, 80).data;
      if (pixels[0] === pixels[(12 * 160 + 12) * 4]) throw new Error("Blank media fixture");
      return canvas.toDataURL("image/png").split(",")[1]!;
    }),
    "base64",
  );
  await page
    .getByLabel("Add attachment", { exact: true })
    .setInputFiles({ name: "editorial-proof.png", mimeType: "image/png", buffer: bitmap });
  await page.getByRole("button", { name: "Upload attachment", exact: true }).click();
  await expect(page.locator(".attachment-state")).toHaveText("ready");
  const assetId = (await read()).state.attachments[0].assetId;
  await expect
    .poll(
      async () => {
        const response = await page.request.get(`/api/resources/asset/${assetId}`, {
          headers: { "x-content-ops-fixture": "editor_2" },
        });
        return response.ok() ? (await response.json()).data.resource.state.status : undefined;
      },
      { timeout: 30_000 },
    )
    .toBe("ready");
  await expect
    .poll(() =>
      page
        .getByRole("region", { name: "Attachments", exact: true })
        .locator("img")
        .evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth === 160),
    )
    .toBe(true);
  await page.getByLabel("Assigned editor", { exact: true }).selectOption("editor_2");
  await page.getByRole("button", { name: "Submit for review", exact: true }).click();
  await expect(page.getByRole("link", { name: "Open review", exact: true })).toBeVisible();
  const reviewId = (await read()).state.review.reviewId;
  await expect
    .poll(
      async () =>
        (
          await page.request.get(`/api/resources/reviewTask/${reviewId}`, {
            headers: { "x-content-ops-fixture": "editor_2" },
          })
        ).ok(),
      { timeout: 30_000 },
    )
    .toBe(true);
  await page.getByRole("link", { name: "Open review", exact: true }).click();
  await page.getByLabel("Fixture identity").selectOption("author_2");
  await expect(page.getByRole("button", { name: "Approve", exact: true })).toHaveCount(0);
  await page.getByLabel("Fixture identity").selectOption("editor_2");
  await page.getByLabel("Decision note").fill("Approved through the browser.");
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Recorded decision", exact: true })).toBeVisible();
  await expect
    .poll(
      async () => {
        const response = await page.request.get(`/api/resources/reviewTask/${reviewId}`, {
          headers: { "x-content-ops-fixture": "editor_2" },
        });
        return response.ok() ? (await response.json()).data.resource.state.status : undefined;
      },
      { timeout: 30_000 },
    )
    .toBe("approved");
  await page.getByRole("link", { name: "Current content", exact: true }).click();
  await page.getByLabel("Publication time zone", { exact: true }).selectOption("UTC");
  await page
    .getByLabel("Publication time", { exact: true })
    .fill(new Date(Date.now() + 30_000).toISOString().slice(0, 19));
  await page.getByRole("button", { name: "Schedule publication", exact: true }).click();
  const scheduling = page.getByRole("region", { name: "Scheduling", exact: true });
  await expect(scheduling.getByRole("status")).toHaveText("Schedule saved.");
  await scheduling.getByRole("link", { name: "Calendar", exact: true }).click();
  await page.getByRole("button", { name: "Agenda view", exact: true }).click();
  await page
    .getByRole("region", { name: "Scheduled agenda", exact: true })
    .getByRole("link", { name: title, exact: true })
    .click();
  await page.getByRole("link", { name: "Back to calendar", exact: true }).click();
  await expect(page).toHaveURL(/view=agenda/);
  await page.getByRole("link", { name: title, exact: true }).click();
  const committed = page.getByRole("region", { name: "Committed publication", exact: true });
  await expect(committed.getByRole("heading", { name: title, exact: true })).toBeVisible({
    timeout: 180_000,
  });
  await expect
    .poll(() =>
      committed
        .getByRole("img")
        .evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth === 160),
    )
    .toBe(true);
  const download = page.waitForEvent("download");
  await committed.getByRole("link", { name: "Download redacted JSON", exact: true }).click();
  const file = await download;
  expect(await file.failure()).toBeNull();
  const artifact = JSON.parse(await readFile((await file.path())!, "utf8"));
  expect(artifact.contentId).toBe(id);
  expect(artifact.content.attachments).toHaveLength(1);
  expect(JSON.stringify(artifact)).not.toMatch(/objectKey|fencingToken/);
  await assertLayout(page);
  await page.screenshot({ path: info.outputPath("scheduled-publication.png"), fullPage: true });
  await expect
    .poll(
      async () => {
        const response = await page.request.get(
          `/api/operations?view=notifications&contentId=${id}&limit=100`,
          { headers: { "x-content-ops-fixture": "editor_2" } },
        );
        return (await response.json()).data.items.length;
      },
      { timeout: 30_000 },
    )
    .toBe(3);
  await page.goto(`/operations?view=notifications&contentId=${id}&limit=1`);
  await expect(page.getByText("1 operation loaded", { exact: true })).toBeVisible();
  for (const count of [2, 3]) {
    await page.getByRole("button", { name: "Load more operations", exact: true }).click();
    await expect(page.getByText(`${count} operations loaded`, { exact: true })).toBeVisible();
  }
  await page.getByRole("button", { name: "Publication attempts", exact: true }).click();
  await expect(page).toHaveURL(/view=attempts/);
  await expect(page.locator(".operation-record")).toHaveCount(1);
  await expect(page.locator(".operation-state")).toHaveText("succeeded");
  const row = await (
    await page.request.get(`/api/resources/contentItem/${id}`, {
      headers: { "x-content-ops-fixture": "editor_2" },
    })
  ).json();
  expect(row.data.resource.state.status).toBe("published");
});
