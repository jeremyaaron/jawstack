import "@angular/compiler";
import { createMemoryApiRuntime } from "../../src/application/api-runtime";
import { createFixtureClock } from "../../src/application/runtime";
import { createPublisher, type PublicationFaultPoint } from "../../src/application/publisher";
import { startContentApi } from "../../src/http/server";
import type {
  ContentOperationsClient,
  ContentResource,
  CommandResult,
  CommandInput,
  CommandName,
} from "../../src/web/client";
import { parseContentEvent } from "../../src/shared/events";
import type { FixtureId } from "../../src/shared/identities";

type HostClient = Pick<ContentOperationsClient, "getContent" | "mutate">;
async function harness<C extends HostClient>(
  factory: (base: string, fixture: () => FixtureId) => Promise<C>,
) {
  const clock = createFixtureClock("2027-03-01T12:00:00.000Z");
  const runtime = createMemoryApiRuntime({ clock: clock.now });
  const api = await startContentApi({
    runtime,
    port: 0,
    webPort: Number(process.env.CONTENT_OPS_E2E_WEB_PORT ?? 4436),
    managed: false,
  });
  let actor: FixtureId = "author_1";
  const client = await factory(`${api.baseUrl}/api`, () => actor);
  const current = (id: string) => client.getContent(id);
  const wire = (id: string) =>
    [...runtime.app.persistence.store.outbox]
      .reverse()
      .find(
        (event) =>
          event.resourceId === id &&
          ["contentItem.publicationRequested", "contentItem.publicationRetried"].includes(
            event.eventType,
          ),
      )!;
  return {
    clock,
    runtime,
    api,
    client,
    current,
    wire,
    actor: (next: FixtureId) => {
      actor = next;
    },
    create: async (title = "Recovery proof") => {
      actor = "author_1";
      const { resourceId: id } = await client.mutate("create", {
        title,
        body: "Frozen recovery body",
      });
      await client.mutate(
        "submit",
        { expectedVersion: 1, assignedEditorId: "editor_1", dueAt: "2027-03-02T12:00:00.000Z" },
        id,
      );
      actor = "editor_1";
      let row = await current(id);
      await client.mutate(
        "approve",
        {
          expectedVersion: row.version,
          reviewId: row.state.review!.reviewId,
          revisionId: row.state.revisionId,
          note: "Approved",
        },
        id,
      );
      row = await current(id);
      await client.mutate(
        "publishNow",
        {
          expectedVersion: row.version,
          reviewId: row.state.approval!.reviewId,
          revisionId: row.state.revisionId,
        },
        id,
      );
      return id;
    },
    publish: (id: string, fault?: (point: PublicationFaultPoint) => void | Promise<void>) =>
      createPublisher({
        repository: runtime.repository,
        dispatch: runtime.dispatch,
        objects: runtime.objects,
        clock: clock.now,
        ...(fault ? { fault } : {}),
      })(parseContentEvent(wire(id))),
    close: () => api.close(),
  };
}
export const operationsHarness = () =>
  harness(async (base, fixture) => {
    const { ContentOperationsClient } = await import("../../src/web/client");
    return new ContentOperationsClient({ base, fixture });
  });
// Browser test hosts use HTTP only; Angular client code is exercised in the actual page.
export const operationsBrowserHarness = () =>
  harness(async (base, fixture) => {
    const request = async <T>(path: string, input?: unknown): Promise<T> => {
      const response = await fetch(`${base}${path}`, {
        headers: {
          "x-content-ops-fixture": fixture(),
          ...(input ? { "content-type": "application/json" } : {}),
        },
        ...(input ? { method: "POST", body: JSON.stringify(input) } : {}),
      });
      const body = await response.json();
      if (!response.ok || !body.ok) throw new Error("Operations fixture HTTP request failed.");
      return body.data as T;
    };
    return {
      getContent: async (id: string) =>
        (await request<{ resource: ContentResource }>(`/resources/contentItem/${id}`)).resource,
      mutate: async <N extends CommandName>(
        name: N,
        input: CommandInput<N>,
        id?: string,
        key = crypto.randomUUID(),
      ) =>
        request<CommandResult>(`/resources/contentItem/${id ? `${id}/` : ""}commands/${name}`, {
          input,
          idempotencyKey: key,
        }),
    };
  });
