import { readFile } from "node:fs/promises";
import type { Page, APIRequestContext } from "@playwright/test";
import { expect, test } from "./fixtures";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jK1kAAAAASUVORK5CYII=",
  "base64",
);
async function command(
  request: APIRequestContext,
  name: string,
  id: string | undefined,
  input: unknown,
) {
  const response = await request.post(
    `/api/resources/contentItem/${id ? `${id}/` : ""}commands/${name}`,
    {
      headers: { "x-content-ops-fixture": "author_1" },
      data: { input, idempotencyKey: crypto.randomUUID() },
    },
  );
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).data;
}
async function content(request: APIRequestContext, id: string) {
  const response = await request.get(`/api/resources/contentItem/${id}`, {
    headers: { "x-content-ops-fixture": "author_1" },
  });
  expect(response.ok()).toBe(true);
  return (await response.json()).data.resource;
}
async function fits(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const collisions = await page
    .locator(".attachment-item .button")
    .evaluateAll((buttons) =>
      buttons.some((button) => button.scrollWidth > button.clientWidth + 1),
    );
  expect(collisions).toBe(false);
  expect(
    await page
      .locator(".snapshot-body")
      .evaluateAll((blocks) => blocks.every((block) => block.scrollWidth <= block.clientWidth + 1)),
  ).toBe(true);
}
async function bytesForDownload(page: Page, action: () => Promise<unknown>) {
  const pending = page.waitForEvent("download");
  await action();
  const download = await pending;
  expect(await download.failure()).toBeNull();
  return readFile((await download.path())!);
}
test("uploads actual images and PDF bytes, publishes approved content and downloads committed references", async ({
  page,
}, info) => {
  test.setTimeout(60_000);
  const title = `Publication proof ${info.project.name}`;
  const created = await command(page.request, "create", undefined, {
    title,
    body: "<b>Verified content, not executable HTML.</b>",
  });
  await page.goto(`/content/${created.resourceId}`);
  const attachments = page.getByRole("region", { name: "Attachments", exact: true });
  const fileInput = page.getByLabel("Add attachment", { exact: true });
  await fileInput.setInputFiles({ name: "<script>.png", mimeType: "image/png", buffer: png });
  await expect(attachments.getByRole("alert")).toContainText("safe filename");
  await fileInput.setInputFiles({
    name: "too-large.png",
    mimeType: "image/png",
    buffer: Buffer.alloc(10 * 1024 * 1024 + 1),
  });
  await expect(attachments.getByRole("alert")).toContainText("10 MiB");
  // The bitmap is the actual file uploaded, stored, downloaded, hashed and rendered by the app.
  const bitmap = Buffer.from(
    await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 480;
      canvas.height = 240;
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#f0f5f4";
      ctx.fillRect(0, 0, 480, 240);
      ctx.fillStyle = "#194c3a";
      ctx.font = "bold 26px sans-serif";
      ctx.fillText("Editorial proof", 28, 52);
      ctx.font = "16px sans-serif";
      ctx.fillText("Content operations / approved media", 28, 84);
      ctx.fillStyle = "#27765b";
      ctx.fillRect(28, 120, 250, 24);
      ctx.fillStyle = "#467b9c";
      ctx.fillRect(28, 156, 340, 24);
      ctx.fillStyle = "#aa7b22";
      ctx.fillRect(28, 192, 180, 20);
      return canvas.toDataURL("image/png").split(",")[1]!;
    }),
    "base64",
  );
  const filename = `Editorial-proof-${"verified-".repeat(16)}image.png`;
  await fileInput.setInputFiles({ name: filename, mimeType: "image/png", buffer: bitmap });
  await page.getByRole("button", { name: "Upload attachment", exact: true }).click();
  const imageCard = attachments
    .getByRole("listitem")
    .filter({ has: page.getByText(filename, { exact: true }) });
  await expect(imageCard.locator(".attachment-state")).toHaveText("ready");
  await expect(fileInput).toBeFocused();
  await expect(imageCard.getByRole("img", { name: filename, exact: true })).toBeVisible();
  await expect
    .poll(() =>
      imageCard
        .locator("img")
        .evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth === 480),
    )
    .toBe(true);
  const downloadedImage = await bytesForDownload(page, () =>
    imageCard.getByRole("button", { name: `Download ${filename}`, exact: true }).click(),
  );
  expect(downloadedImage).toEqual(bitmap);
  const pdfPage = await page.context().newPage();
  await pdfPage.setContent(
    "<h1>Content operations proof</h1><p>Real downloadable PDF fixture.</p>",
  );
  const pdf = await pdfPage.pdf();
  await pdfPage.close();
  await fileInput.setInputFiles({
    name: "review-proof.pdf",
    mimeType: "application/pdf",
    buffer: pdf,
  });
  await page.getByRole("button", { name: "Upload attachment", exact: true }).click();
  const pdfCard = attachments
    .getByRole("listitem")
    .filter({ has: page.getByText("review-proof.pdf", { exact: true }) });
  await expect(pdfCard.locator(".attachment-state")).toHaveText("ready");
  expect(
    await bytesForDownload(page, () =>
      pdfCard.getByRole("button", { name: "Download review-proof.pdf", exact: true }).click(),
    ),
  ).toEqual(pdf);
  await expect(attachments.locator("iframe,embed,object")).toHaveCount(0);
  await fits(page);
  await page.screenshot({ path: info.outputPath("attachments.png"), fullPage: true });
  await page.getByRole("button", { name: "Submit for review", exact: true }).click();
  await page.getByRole("link", { name: "Open review", exact: true }).click();
  await page.getByLabel("Fixture identity").selectOption("editor_1");
  await page.getByLabel("Decision note").fill("Approved the verified image and PDF.");
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await page.getByRole("heading", { name: "Recorded decision", exact: true }).waitFor();
  await page.getByRole("link", { name: "Current content", exact: true }).click();
  await page.getByRole("button", { name: "Publish now", exact: true }).click();
  const committed = page.getByRole("region", { name: "Committed publication", exact: true });
  await expect(committed.getByRole("heading", { name: title, exact: true })).toBeVisible();
  await expect(committed).toContainText("<b>Verified content, not executable HTML.</b>");
  await expect(committed.locator("pre b")).toHaveCount(0);
  const artifact = JSON.parse(
    (
      await bytesForDownload(page, () =>
        committed.getByRole("link", { name: "Download redacted JSON", exact: true }).click(),
      )
    ).toString("utf8"),
  );
  expect(artifact.contentId).toBe(created.resourceId);
  expect(artifact.content.attachments).toHaveLength(2);
  expect(JSON.stringify(artifact)).not.toMatch(/objectKey|fencingToken/);
  expect(artifact.content.body).toBe("<b>Verified content, not executable HTML.</b>");
  expect(
    await bytesForDownload(page, () =>
      committed.getByRole("button", { name: "Download review-proof.pdf", exact: true }).click(),
    ),
  ).toEqual(pdf);
  await expect(page.getByLabel("Add attachment", { exact: true })).toHaveCount(0);
  await expect(attachments.getByRole("button", { name: /^Remove / })).toHaveCount(0);
  await expect(page.getByLabel("Body", { exact: true })).toBeDisabled();
  await expect
    .poll(() =>
      committed
        .getByRole("img")
        .evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0),
    )
    .toBe(true);
  await fits(page);
  await page.screenshot({ path: info.outputPath("committed-publication.png"), fullPage: true });
});
test("interrupted uploads retain the file for retry and stale registrations preserve the current draft", async ({
  page,
}, info) => {
  test.setTimeout(60_000);
  const created = await command(page.request, "create", undefined, {
    title: `Interrupted media ${info.project.name}`,
    body: "Local unchanged body",
  });
  await page.goto(`/content/${created.resourceId}`);
  const attachments = page.getByRole("region", { name: "Attachments", exact: true });
  await page
    .getByLabel("Add attachment", { exact: true })
    .setInputFiles({ name: "retry.png", mimeType: "image/png", buffer: png });
  await page.route("**/api/uploads/**", (route) => route.abort("connectionfailed"), { times: 1 });
  await page.getByRole("button", { name: "Upload attachment", exact: true }).click();
  await expect(attachments.getByRole("alert")).toContainText("selected file is preserved");
  await expect(attachments.locator(".attachment-state")).toHaveText("pending");
  await expect(attachments.getByRole("img")).toHaveCount(0);
  await page.getByLabel("Body", { exact: true }).fill("Local saved body survives retry");
  await expect(page.getByRole("button", { name: "Retry upload", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Retry upload", exact: true }).click();
  await expect(attachments.locator(".attachment-state")).toHaveText("ready");
  await expect(page.getByLabel("Body", { exact: true })).toHaveValue(
    "Local saved body survives retry",
  );
  const row = await content(page.request, created.resourceId);
  expect(row.state.attachments).toHaveLength(1);
  await page.getByRole("button", { name: "Remove retry.png", exact: true }).click();
  await expect(attachments.locator(".attachment-state")).toHaveText("removed");
  const removed = await content(page.request, created.resourceId);
  await command(page.request, "editDraft", created.resourceId, {
    expectedVersion: removed.version,
    title: row.state.title,
    body: "New concurrent server body",
  });
  await page
    .getByLabel("Add attachment", { exact: true })
    .setInputFiles({ name: "another.png", mimeType: "image/png", buffer: png });
  await page.getByRole("button", { name: "Upload attachment", exact: true }).click();
  await expect(attachments.getByRole("alert")).toContainText("Content changed");
  await expect(page.getByLabel("Body", { exact: true })).toHaveValue(
    "Local saved body survives retry",
  );
  await expect(attachments.locator(".transfer-state")).toContainText("another.png");
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByLabel("Fixture identity").selectOption("author_2");
  await expect(page.getByLabel("Fixture identity")).toHaveValue("author_1");
  await fits(page);
  await page.screenshot({ path: info.outputPath("upload-conflict.png"), fullPage: true });
});
