import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { operationsBrowserHarness as operationsHarness } from "../support/operations";
import { PublicationExecutionError } from "../../src/application/publication-artifact";
import { SimulatedPublicationCrash } from "../../src/application/publisher";
import { publicationRequestSchema } from "../../src/shared/contracts";
import { createFailureService } from "../../src/application/failures";
import { fixtureAuth } from "../../src/shared/identities";

async function connect(page: Page, h: Awaited<ReturnType<typeof operationsHarness>>) {
  await page.clock.setFixedTime(h.clock.now());
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const response = await route.fetch({ url: `${h.api.baseUrl}${url.pathname}${url.search}` });
    await route.fulfill({ response });
  });
}
async function fits(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(
    await page
      .locator(".operation-record,.operation-metadata,.operation-tabs")
      .evaluateAll((nodes) => nodes.every((node) => node.scrollWidth <= node.clientWidth + 1)),
  ).toBe(true);
}
test("observes queued/running/failed publication, retries a lost response once, and inspects real attempts/notifications", async ({
  page,
}, info) => {
  test.setTimeout(60_000);
  const h = await operationsHarness();
  let release: () => void = () => {};
  let publishing: Promise<unknown> | undefined;
  try {
    const id = await h.create(`Recovery ${info.project.name}`);
    await connect(page, h);
    await page.goto(`/operations?view=attempts&contentId=${id}&limit=1`);
    await expect(page.getByRole("alert")).toContainText("cannot read operations");
    await page.getByLabel("Fixture identity").selectOption("editor_1");
    const recovery = page.getByRole("region", { name: "Publication recovery", exact: true });
    await expect(recovery.locator(".recovery-state")).toHaveText("Queued");
    let claimed!: () => void;
    const ready = new Promise<void>((done) => {
      claimed = done;
    });
    const gate = new Promise<void>((done) => {
      release = done;
    });
    publishing = h
      .publish(id, async (point) => {
        if (point === "afterClaim") {
          claimed();
          await gate;
        }
        if (point === "beforeCompletion") throw new PublicationExecutionError("artifact.mismatch");
      })
      .catch((error) => error);
    await ready;
    await expect(recovery.locator(".recovery-state")).toHaveText("Running");
    await expect(
      page.getByRole("button", { name: "Retry publication", exact: true }),
    ).toBeDisabled();
    await expect(page.locator(".operation-state")).toHaveText("claimed");
    await fits(page);
    await page.screenshot({ path: info.outputPath("running-publication.png"), fullPage: true });
    release();
    await publishing;
    await expect(recovery.locator(".recovery-state")).toHaveText("Failed");
    await expect(recovery).toContainText("artifact.mismatch");
    const intent = publicationRequestSchema.parse(h.wire(id).payload).intent;
    const bytes = await h.runtime.objects.readPublication(intent);
    const keys: string[] = [];
    await page.route(
      `**/api/resources/contentItem/${id}/commands/retryPublication`,
      async (route) => {
        keys.push(route.request().postDataJSON().idempotencyKey);
        if (keys.length === 1) {
          const response = await route.fetch({
            url: `${h.api.baseUrl}/api/resources/contentItem/${id}/commands/retryPublication`,
          });
          expect(response.ok()).toBe(true);
          await route.abort("connectionfailed");
        } else await route.fallback();
      },
    );
    await page.getByRole("button", { name: "Retry publication", exact: true }).click();
    await expect(recovery.getByRole("alert")).toContainText("preserved");
    await page.getByRole("button", { name: "Retry publication", exact: true }).click();
    await expect(recovery.locator(".recovery-state")).toHaveText("Queued");
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    expect((await h.current(id)).state.publication!.generation).toBe(2);
    await h.publish(id);
    await h.runtime.app.drainUntilIdle();
    await expect(recovery.locator(".recovery-state")).toHaveText("Succeeded");
    expect(await h.runtime.objects.readPublication(intent)).toEqual(bytes);
    await page.getByRole("button", { name: "Refresh operations", exact: true }).click();
    await expect(page.getByText("1 operation loaded", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Load more operations", exact: true }).click();
    await expect(page.getByText("2 operations loaded", { exact: true })).toBeVisible();
    const failedAttempt = page.locator(".operation-record").filter({
      has: page.getByRole("heading", { name: "Publication attempt · generation 1", exact: true }),
    });
    await failedAttempt.getByText("Trace details", { exact: true }).click();
    await expect(failedAttempt).toContainText("artifact.mismatch");
    await fits(page);
    await page.screenshot({ path: info.outputPath("recovered-attempts.png"), fullPage: true });
    await page.getByRole("button", { name: "Notifications", exact: true }).click();
    await expect(page.locator(".operation-record")).toHaveCount(1);
    await page.getByLabel("Notification recipient").selectOption("author_1");
    await page.getByRole("button", { name: "Apply operation filters", exact: true }).click();
    await expect(page).toHaveURL(/recipientId=author_1/);
    await page
      .locator(".operation-record")
      .first()
      .getByText("Trace details", { exact: true })
      .click();
    await expect(page.locator(".operation-record").first()).toContainText("Correlation");
    await fits(page);
    await page.screenshot({ path: info.outputPath("notification-trace.png"), fullPage: true });
    await page.getByLabel("Fixture identity").selectOption("author_1");
    await expect(page.locator(".operation-record")).toHaveCount(0);
    await expect(page.getByRole("alert")).toContainText("cannot read operations");
  } finally {
    release();
    await publishing;
    await page.unrouteAll({ behavior: "wait" });
    await h.close();
  }
});
test("shows live versus expired leases and resumable failure/replay records without browser replay controls", async ({
  page,
}, info) => {
  test.setTimeout(60_000);
  const h = await operationsHarness();
  try {
    const id = await h.create(`Stalled ${info.project.name}`);
    await connect(page, h);
    await expect(
      h.publish(id, (point) => {
        if (point === "afterClaim") throw new SimulatedPublicationCrash();
      }),
    ).rejects.toThrow();
    await page.goto(`/operations?contentId=${id}`);
    await page.getByLabel("Fixture identity").selectOption("editor_1");
    const recovery = page.getByRole("region", { name: "Publication recovery", exact: true });
    await expect(recovery.locator(".recovery-state")).toHaveText("Running");
    await expect(recovery).toContainText("Active");
    h.clock.advance(90000);
    await page.clock.setFixedTime(h.clock.now());
    await page.getByRole("button", { name: "Refresh publication", exact: true }).click();
    await expect(recovery.locator(".recovery-state")).toHaveText("Stalled");
    await expect(recovery).toContainText("Lease expired");
    await expect(
      page.getByRole("button", { name: "Retry publication", exact: true }),
    ).toBeEnabled();
    const wire = h.wire(id);
    const collector = createFailureService({
      source: "content-operations",
      store: h.runtime.app.failureStore,
      repository: h.runtime.repository,
      dispatch: h.runtime.dispatch,
      clock: h.clock.now,
      fault: (point) => {
        if (point === "afterRecord") throw new Error("Interrupted collector");
      },
    });
    await expect(collector.collect("publishContent", wire)).rejects.toThrow();
    await page.getByRole("button", { name: "Failures", exact: true }).click();
    await expect(page.locator(".operation-state")).toHaveText("reconciling");
    await h.runtime.app.failures.collect("publishContent", wire);
    await expect(page.locator(".operation-state")).toHaveText("failed");
    await page.getByText("Trace details", { exact: true }).click();
    await expect(page.locator(".failure-history")).toContainText("stalled");
    await fits(page);
    await page.screenshot({ path: info.outputPath("stalled-failure.png"), fullPage: true });
    await expect(page.getByRole("button", { name: /Replay/ })).toHaveCount(0);
    const other = await h.create(`Notification recovery ${info.project.name}`);
    const event = h.runtime.app.persistence.store.outbox.find(
      (event) => event.resourceId === other && event.eventType === "contentItem.reviewRequested",
    )!;
    const collected = await h.runtime.app.failures.collect("deliverNotification", event);
    // Only the test host invokes the recovery service used by the development CLI.
    await h.runtime.app.failures.replay(collected.id, fixtureAuth("editor_1"), crypto.randomUUID());
    await page.goto(`/operations?view=failures&contentId=${other}`);
    await expect(page.locator(".operation-state")).toHaveText("replayQueued");
    await h.runtime.app.drainUntilIdle();
    await expect(page.locator(".operation-state")).toHaveText("resolved");
    await page.getByText("Trace details", { exact: true }).click();
    await expect(page.locator(".operation-record")).toContainText("Recovery requests");
    await expect(page.locator(".operation-record")).toContainText("editor_1");
    await fits(page);
    await page.screenshot({ path: info.outputPath("resolved-failure.png"), fullPage: true });
  } finally {
    await page.unrouteAll({ behavior: "wait" });
    await h.close();
  }
});
