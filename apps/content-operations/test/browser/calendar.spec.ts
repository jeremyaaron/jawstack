import "@angular/compiler";
import { expect, test, type Page } from "@playwright/test";
import { createMemoryApiRuntime } from "../../src/application/api-runtime";
import { createFixtureClock } from "../../src/application/runtime";
import { startContentApi } from "../../src/http/server";

async function harness(page: Page, initial = "2027-03-01T12:00:00.000Z") {
  const clock = createFixtureClock(initial);
  const runtime = createMemoryApiRuntime({ clock: clock.now });
  const api = await startContentApi({
    runtime,
    port: 0,
    webPort: Number(process.env.CONTENT_OPS_E2E_WEB_PORT ?? 4436),
    managed: false,
  });
  await page.clock.setFixedTime(clock.now());
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const response = await route.fetch({ url: `${api.baseUrl}${url.pathname}${url.search}` });
    await route.fulfill({ response });
  });
  const request = async (path: string, input?: unknown, actor = "editor_1") => {
    const response = await fetch(`${api.baseUrl}/api${path}`, {
      headers: {
        "x-content-ops-fixture": actor,
        ...(input ? { "content-type": "application/json" } : {}),
      },
      ...(input ? { method: "POST", body: JSON.stringify(input) } : {}),
    });
    const body = await response.json();
    expect(response.ok, JSON.stringify(body)).toBe(true);
    return body.data;
  };
  const command = (id: string | undefined, name: string, input: unknown, actor = "editor_1") =>
    request(
      `/resources/contentItem/${id ? `${id}/` : ""}commands/${name}`,
      { input, idempotencyKey: crypto.randomUUID() },
      actor,
    );
  const read = async (id: string) => (await request(`/resources/contentItem/${id}`)).resource;
  return {
    request,
    command,
    read,
    create: async (title: string, scheduledAt?: string) => {
      const { resourceId: id } = await command(
        undefined,
        "create",
        { title, body: "Approved calendar content" },
        "author_1",
      );
      await command(
        id,
        "submit",
        {
          expectedVersion: 1,
          assignedEditorId: "editor_1",
          dueAt: new Date(clock.now().getTime() + 86400000).toISOString(),
        },
        "author_1",
      );
      let row = await read(id);
      await command(id, "approve", {
        expectedVersion: row.version,
        reviewId: row.state.review.reviewId,
        revisionId: row.state.revisionId,
        note: "Approved",
      });
      row = await read(id);
      if (scheduledAt)
        await command(id, "schedule", {
          expectedVersion: row.version,
          reviewId: row.state.approval.reviewId,
          revisionId: row.state.revisionId,
          scheduledAt,
          timeZone: "UTC",
        });
      return id;
    },
    advance: async (instant: string) => {
      clock.advance(Date.parse(instant) - clock.now().getTime());
      await page.clock.setFixedTime(clock.now());
      // The test host drives the real due-job/publisher protocols. There is no browser clock endpoint or direct publish command.
      await runtime.tick!();
      await runtime.app.drainUntilIdle();
    },
    close: async () => {
      await page.unrouteAll({ behavior: "wait" });
      await api.close();
    },
  };
}
async function fits(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(
    await page
      .locator(".calendar-day,.agenda-row,.scheduling-form")
      .evaluateAll((nodes) => nodes.every((node) => node.scrollWidth <= node.clientWidth + 1)),
  ).toBe(true);
}
test("schedules, browses zoned month/agenda, reschedules/cancels old work, and observes real due publication", async ({
  page,
}, info) => {
  test.setTimeout(60_000);
  const h = await harness(page);
  try {
    const title = `Scheduled lifecycle ${info.project.name}`;
    const id = await h.create(title);
    await page.goto(`/content/${id}`);
    await page.getByLabel("Fixture identity").selectOption("editor_1");
    const scheduling = page.getByRole("region", { name: "Scheduling", exact: true });
    await page.getByLabel("Publication time", { exact: true }).fill("2027-03-01T13:00:00.1");
    await page.getByRole("button", { name: "Schedule publication", exact: true }).click();
    await expect(scheduling.getByRole("status")).toHaveText("Schedule saved.");
    await expect(scheduling.getByRole("status")).toBeFocused();
    await scheduling.getByRole("link", { name: "Calendar", exact: true }).click();
    await expect(page.getByText("1 scheduled item loaded", { exact: true })).toBeVisible();
    await expect(page.locator(".calendar-day-items time")).toHaveText("13:00");
    await fits(page);
    await page.screenshot({ path: info.outputPath("scheduled-month.png"), fullPage: true });
    await page.getByLabel("Display time zone").selectOption("America/New_York");
    await page.getByRole("button", { name: "Apply", exact: true }).click();
    await expect(page.locator(".calendar-day-items time")).toHaveText("08:00");
    await page.getByRole("button", { name: "Agenda view", exact: true }).click();
    const agenda = page.getByRole("region", { name: "Scheduled agenda", exact: true });
    await expect(agenda.locator("time")).toHaveAttribute("datetime", "2027-03-01T13:00:00.100Z");
    await expect(agenda.locator("time")).toContainText("EST");
    await fits(page);
    await page.screenshot({ path: info.outputPath("scheduled-agenda.png"), fullPage: true });
    await agenda.getByRole("link", { name: title, exact: true }).click();
    await page.reload();
    await page.getByRole("link", { name: "Back to calendar", exact: true }).click();
    await expect(page).toHaveURL(/view=agenda/);
    await expect(page.getByLabel("Display time zone")).toHaveValue("America/New_York");
    await page.getByRole("link", { name: title, exact: true }).click();
    await page.getByLabel("Publication time", { exact: true }).fill("2027-03-01T14:00");
    await page.getByRole("button", { name: "Reschedule", exact: true }).click();
    await expect(scheduling.getByRole("status")).toHaveText("Schedule saved.");
    await h.advance("2027-03-01T13:00:01.000Z");
    expect((await h.read(id)).state.status).toBe("scheduled");
    await page.getByRole("button", { name: "Cancel schedule", exact: true }).click();
    await expect(scheduling.getByRole("status")).toHaveText("Schedule cancelled.");
    await h.advance("2027-03-01T14:00:00.000Z");
    expect((await h.read(id)).state.status).toBe("approved");
    await page.getByLabel("Publication time", { exact: true }).fill("2027-03-01T15:00");
    await page.getByRole("button", { name: "Schedule publication", exact: true }).click();
    await expect(scheduling.getByRole("status")).toHaveText("Schedule saved.");
    await page.getByLabel("Publication time", { exact: true }).fill("2027-03-01T16:00");
    await h.advance("2027-03-01T15:00:00.000Z");
    await expect(
      page.getByRole("region", { name: "Committed publication", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Reopen draft", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Cancel schedule", exact: true })).toHaveCount(0);
    await expect(page.getByLabel("Body", { exact: true })).toBeDisabled();
    const view = await h.request(`/content/${id}/publication`);
    expect(view.artifact.schedule.scheduledAt).toBe("2027-03-01T15:00:00.000Z");
    await expect(page.getByLabel("Unapplied local time", { exact: true })).toHaveValue(
      "2027-03-01T16:00",
    );
    await page.getByRole("button", { name: "Discard schedule changes", exact: true }).click();
    await fits(page);
    await page.screenshot({ path: info.outputPath("due-publication.png"), fullPage: true });
  } finally {
    await h.close();
  }
});
test("rejects DST gaps/folds, guards dirty schedule proposals, preserves stale forms, and reopens scheduled content", async ({
  page,
}, info) => {
  test.setTimeout(60_000);
  const h = await harness(page);
  try {
    const id = await h.create(`Schedule conflict ${info.project.name}`);
    await page.goto(`/content/${id}`);
    await page.getByLabel("Fixture identity").selectOption("editor_1");
    const scheduling = page.getByRole("region", { name: "Scheduling", exact: true });
    await page
      .getByLabel("Publication time zone", { exact: true })
      .selectOption("America/New_York");
    for (const value of ["2027-03-14T02:30", "2027-11-07T01:30"]) {
      await page.getByLabel("Publication time", { exact: true }).fill(value);
      await page.getByRole("button", { name: "Schedule publication", exact: true }).click();
      await expect(scheduling.getByRole("alert")).toContainText("unambiguous");
      await expect(page.getByLabel("Publication time", { exact: true })).toBeFocused();
    }
    expect((await h.read(id)).version).toBe(3);
    await page.getByLabel("Publication time", { exact: true }).fill("2027-02-01T12:00");
    await page.getByRole("button", { name: "Schedule publication", exact: true }).click();
    await expect(scheduling.getByRole("alert")).toContainText("future");
    await page.getByLabel("Publication time", { exact: true }).fill("2027-11-07T03:30");
    await page.getByRole("button", { name: "Schedule publication", exact: true }).focus();
    await page.getByRole("button", { name: "Schedule publication", exact: true }).press("Enter");
    await expect(scheduling.getByRole("status")).toHaveText("Schedule saved.");
    const stale = await h.read(id);
    await page.getByLabel("Publication time", { exact: true }).fill("2027-11-08T03:30");
    page.once("dialog", (dialog) => dialog.dismiss());
    await page.getByLabel("Fixture identity").selectOption("author_2");
    await expect(page.getByLabel("Fixture identity")).toHaveValue("editor_1");
    page.once("dialog", (dialog) => dialog.dismiss());
    await page
      .getByRole("navigation", { name: "Primary" })
      .getByRole("link", { name: "Calendar", exact: true })
      .click();
    await expect(page).toHaveURL(new RegExp(`/content/${id}`));
    await h.command(id, "reschedule", {
      expectedVersion: stale.version,
      reviewId: stale.state.approval.reviewId,
      revisionId: stale.state.revisionId,
      scheduleGeneration: stale.state.schedule.generation,
      scheduledAt: "2027-11-09T08:30:00.000Z",
      timeZone: "America/New_York",
    });
    await page.getByRole("button", { name: "Reschedule", exact: true }).click();
    await expect(scheduling.getByRole("alert")).toContainText("preserved");
    await expect(page.getByLabel("Publication time", { exact: true })).toHaveValue(
      "2027-11-08T03:30",
    );
    await expect(page.getByRole("button", { name: "Cancel schedule", exact: true })).toBeDisabled();
    await fits(page);
    await page.screenshot({ path: info.outputPath("schedule-conflict.png"), fullPage: true });
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(page.getByLabel("Publication time", { exact: true })).toHaveValue(
      "2027-11-09T03:30",
    );
    await page.getByLabel("Fixture identity").selectOption("author_1");
    await expect(page.getByLabel("Publication time", { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Reopen draft", exact: true }).click();
    await expect(page.getByLabel("Body", { exact: true })).toBeEnabled();
    await h.advance("2027-11-10T12:00:00.000Z");
    expect((await h.read(id)).state.status).toBe("draft");
  } finally {
    await h.close();
  }
});
test("calendar pages zoned month boundaries, preserves URL state, resets fixture cursors and rejects invalid URLs", async ({
  page,
}, info) => {
  test.setTimeout(60_000);
  const h = await harness(page, "2027-03-01T00:00:00.000Z");
  try {
    const title = `Month boundary ${info.project.name}`;
    await h.create(`Early March ${info.project.name}`, "2027-03-01T23:30:00.000Z");
    await h.create(`Wide ${"W".repeat(140)}`, "2027-03-02T00:30:00.000Z");
    await h.create(title, "2027-04-01T03:30:00.000Z");
    await h.create("Outside requested local month", "2027-03-01T03:30:00.000Z");
    await page.goto("/calendar?date=2027-03-15&zone=America%2FNew_York&view=month&limit=1");
    await expect(page.getByText("1 scheduled item loaded", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Load more scheduled items", exact: true }).click();
    await expect(page.getByText("2 scheduled items loaded", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Agenda view", exact: true }).click();
    await expect(page.getByText("2 scheduled items loaded", { exact: true })).toBeVisible();
    await fits(page);
    await page.getByRole("button", { name: "Load more scheduled items", exact: true }).click();
    await expect(page.getByText("3 scheduled items loaded", { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: title, exact: true })).toBeVisible();
    await expect(page.getByText("Outside requested local month", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("region", { name: "2027-03-31", exact: true })).toContainText(
      "11:30:00 PM",
    );
    await fits(page);
    await page.screenshot({ path: info.outputPath("paged-agenda.png"), fullPage: true });
    await page.getByRole("button", { name: "Next month", exact: true }).click();
    await expect(page).toHaveURL(/date=2027-04-15/);
    await expect(page.getByText("No scheduled content this month", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Previous month", exact: true }).click();
    await expect(page.getByText("1 scheduled item loaded", { exact: true })).toBeVisible();
    const params = new URLSearchParams({
      from: "2027-03-01T05:00:00.000Z",
      before: "2027-04-01T04:00:00.000Z",
      limit: "1",
    });
    const first = await h.request(`/calendar?${params}`, undefined, "author_1");
    await page.goto(
      `/calendar?date=2027-03-15&zone=America%2FNew_York&view=agenda&limit=1&cursor=${encodeURIComponent(first.nextCursor)}`,
    );
    await expect(page.getByText("1 scheduled item loaded", { exact: true })).toBeVisible();
    await page.getByLabel("Fixture identity").selectOption("editor_1");
    await expect(page).not.toHaveURL(/cursor=/);
    await expect(
      page.getByRole("link", { name: `Early March ${info.project.name}`, exact: true }),
    ).toBeVisible();
    const editorPage = await h.request(`/calendar?${params}`);
    await page.goto(
      `/calendar?date=2027-03-15&zone=America%2FNew_York&view=agenda&limit=1&cursor=${encodeURIComponent(editorPage.nextCursor)}`,
    );
    await page.getByRole("link", { name: `Wide ${"W".repeat(140)}`, exact: true }).click();
    await expect(
      page.getByRole("heading", { name: `Wide ${"W".repeat(140)}`, exact: true }),
    ).toBeVisible();
    await page.getByLabel("Fixture identity").selectOption("author_2");
    await page.getByRole("link", { name: "Back to calendar", exact: true }).click();
    await expect(page).not.toHaveURL(/cursor=/);
    await expect(
      page.getByRole("link", { name: `Early March ${info.project.name}`, exact: true }),
    ).toBeVisible();
    await page.goto("/calendar?date=2027-02-30&zone=Not%2FA_Zone&view=year");
    await expect(page.getByRole("alert")).toContainText("invalid");
    await expect(page.locator(".calendar-grid,.calendar-agenda")).toHaveCount(0);
  } finally {
    await h.close();
  }
});
