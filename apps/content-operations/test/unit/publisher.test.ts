import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { unzipSync, strFromU8 } from "fflate";
import { GetItemCommand, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { describe, expect, it, vi } from "vitest";
import { SimulatedPublicationCrash } from "../../src/application/publisher";
import {
  PublicationExecutionError,
  serializePublication,
} from "../../src/application/publication-artifact";
import { renderNotification } from "../../src/application/notifications";
import { parseContentEvent } from "../../src/shared/events";
import { createPublicationSqsHandler } from "../../src/aws/publication";
import { publicationHarness } from "../support/publication";
import { buildLab } from "../../scripts/build-lab";

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("recoverable publication", () => {
  it("drains the real memory subscription into one artifact and an author notification", async () => {
    const h = await publicationHarness();
    await h.app.drainUntilIdle();
    const state = await h.current();
    expect(state.state.status).toBe("published");
    expect(state.state.publication!.artifact).toMatchObject(
      serializePublication(h.intent).reference,
    );
    expect(Buffer.from(await h.app.objects.readPublication(h.intent))).toEqual(
      serializePublication(h.intent).bytes,
    );
    const deliveries = [...h.app.notifications.deliveries.values()].filter(
      (n) => n.template === "publication-succeeded.v1",
    );
    expect(deliveries).toMatchObject([
      { recipientId: "author_1", publicationId: h.intent.publicationId },
    ]);
    expect((await h.app.pump.drain()).terminal).toBe(0);
    const version = state.version;
    expect(await h.publisher()(h.event())).toBe("alreadyPublished");
    expect((await h.current()).version).toBe(version);
  });

  it.each(["afterClaim", "afterObjectWrite", "beforeCompletion"] as const)(
    "recovers a process crash at %s only after lease expiry",
    async (point) => {
      const h = await publicationHarness();
      await expect(
        h.publisher({
          fault: (p) => {
            if (p === point) throw new SimulatedPublicationCrash();
          },
        })(h.event()),
      ).rejects.toBeInstanceOf(SimulatedPublicationCrash);
      const interrupted = await h.current();
      expect(interrupted.state).toMatchObject({
        status: "publishing",
        publication: { phase: "running", artifact: null },
      });
      if (point !== "afterClaim")
        expect(Buffer.from(await h.app.objects.readPublication(h.intent))).toEqual(
          serializePublication(h.intent).bytes,
        );
      else
        await expect(h.app.objects.readPublication(h.intent)).rejects.toMatchObject({
          failureCode: "storage.unavailable",
        });
      await expect(h.publisher()(h.event())).rejects.toMatchObject({ code: "resource.conflict" });
      h.clock.advance(90_000);
      expect(await h.publisher()(h.event())).toBe("published");
      expect((await h.current()).state.publication).toMatchObject({
        phase: "succeeded",
        attemptsInGeneration: 2,
        intent: h.intent,
      });
      const history = await h.app.persistence.repository.listProjection(
        `contentItem.publicationAttempts.${h.contentId}`,
      );
      expect(
        history.map((row) => (row.data as { attempt: { status: string } }).attempt.status).sort(),
      ).toEqual(["expired", "succeeded"]);
    },
  );

  it("does not acknowledge a duplicate competing with a live claim", async () => {
    const h = await publicationHarness();
    const claimed = signal();
    const resume = signal();
    const first = h.publisher({
      fault: async (point) => {
        if (point === "afterClaim") {
          claimed.resolve();
          await resume.promise;
        }
      },
    })(h.event());
    await claimed.promise;
    await expect(h.publisher()(h.event())).rejects.toMatchObject({ code: "resource.conflict" });
    resume.resolve();
    expect(await first).toBe("published");
    expect((await h.current()).state.publication!.attemptsInGeneration).toBe(1);
  });

  it("does not let a resumed stale worker fail a new owner's active claim", async () => {
    const h = await publicationHarness();
    const wrote = signal();
    const resume = signal();
    const first = h.publisher({
      fault: async (point) => {
        if (point === "afterObjectWrite") {
          wrote.resolve();
          await resume.promise;
        }
      },
    })(h.event());
    const rejected = expect(first).rejects.toMatchObject({ code: "resource.conflict" });
    await wrote.promise;
    h.clock.advance(90_000);
    await expect(
      h.publisher({
        fault: (point) => {
          if (point === "afterClaim") throw new SimulatedPublicationCrash();
        },
      })(h.event()),
    ).rejects.toBeInstanceOf(SimulatedPublicationCrash);
    const newClaim = (await h.current()).state.publication!.claim;
    resume.resolve();
    await rejected;
    expect((await h.current()).state.publication!.claim).toEqual(newClaim);
    h.clock.advance(90_000);
    expect(await h.publisher()(h.event())).toBe("published");
  });

  it("leaves completion durable across a crash before the transport marker", async () => {
    const h = await publicationHarness();
    await expect(
      h.publisher({
        fault: (point) => {
          if (point === "afterCompletion") throw new SimulatedPublicationCrash();
        },
      })(h.event()),
    ).rejects.toBeInstanceOf(SimulatedPublicationCrash);
    const before = await h.current();
    const write = vi.spyOn(h.app.objects, "createPublication");
    expect(await h.publisher()(h.event())).toBe("alreadyPublished");
    expect(await h.current()).toEqual(before);
    expect(write).not.toHaveBeenCalled();
    expect(
      h.app.persistence.store.outbox.filter((e) => e.eventType === "contentItem.published"),
    ).toHaveLength(1);
  });

  it("records transient failures and terminalizes only at the attempt budget", async () => {
    const h = await publicationHarness();
    const failing = h.publisher({
      objects: {
        ...h.app.objects,
        createPublication: async () => {
          throw new PublicationExecutionError("storage.unavailable");
        },
      },
    });
    for (let attempt = 1; attempt <= 3; attempt++) {
      await expect(failing(h.event())).rejects.toMatchObject({
        failureCode: "storage.unavailable",
      });
      expect((await h.current()).state.publication).toMatchObject({
        attemptsInGeneration: attempt,
        phase: attempt === 3 ? "failed" : "queued",
        claim: null,
      });
    }
    await expect(failing(h.event())).rejects.toMatchObject({ code: "command.rejected" });
    expect(
      h.app.persistence.store.outbox.filter((e) => e.eventType === "contentItem.publicationFailed"),
    ).toHaveLength(1);
  });

  it("fails mismatched existing bytes without overwriting, then recovers the same key in a new generation", async () => {
    const h = await publicationHarness();
    const changed = { ...h.intent, snapshot: { ...h.intent.snapshot, body: "Foreign bytes" } };
    await h.app.objects.createPublication(changed);
    await expect(h.publisher()(h.event())).rejects.toMatchObject({
      failureCode: "artifact.mismatch",
    });
    expect((await h.current()).state.publication).toMatchObject({
      phase: "failed",
      attemptsInGeneration: 1,
      artifact: null,
    });
    expect(Buffer.from(await h.app.objects.readPublication(changed))).toEqual(
      serializePublication(changed).bytes,
    );
    const failed = parseContentEvent(
      h.app.persistence.store.outbox.find((e) => e.eventType === "contentItem.publicationFailed")!,
    );
    await h.app.workers.handle(
      "deliverNotification",
      h.app.persistence.store.outbox.find((e) => e.eventType === "contentItem.publicationFailed")!,
    );
    const { originalEventId: _original, ...failedEnvelope } = failed;
    expect(_original).toBe(failed.eventId);
    const replay = parseContentEvent({
      ...failedEnvelope,
      eventId: randomUUID(),
      occurredAt: "2026-11-02T12:00:00.000Z",
      payload: { ...failed.payload, delivery: { originalEventId: failed.eventId, generation: 1 } },
    });
    expect(renderNotification(replay, h.clock.now()).occurredAt).toBe(
      renderNotification(failed, h.clock.now()).occurredAt,
    );
    const old = h.event();
    const row = await h.current();
    expect(
      (
        await h.run("retryPublication", {
          expectedVersion: row.version,
          publicationId: h.intent.publicationId,
          generation: 1,
        })
      ).ok,
    ).toBe(true);
    expect(await h.publisher()(old)).toBe("ignored");
    // Operator repair is represented by a clean destination, never an overwrite API.
    const { createMemoryObjectStore } = await import("../../src/application/object-store");
    const repaired = createMemoryObjectStore();
    expect(await h.publisher({ objects: repaired })(h.event())).toBe("published");
    expect((await h.current()).state.publication!.artifact).toMatchObject(
      serializePublication(h.intent).reference,
    );
  });

  it("rejects altered frozen intent before claiming and hides raw execution errors", async () => {
    const h = await publicationHarness();
    const event = h.event();
    const { originalEventId: _original, ...envelope } = event;
    expect(_original).toBe(event.eventId);
    const changed = parseContentEvent({
      ...envelope,
      payload: {
        ...event.payload,
        intent: { ...h.intent, snapshot: { ...h.intent.snapshot, body: "Tampered" } },
      },
    });
    await expect(h.publisher()(changed)).rejects.toMatchObject({ code: "command.validation" });
    expect((await h.current()).state.publication!.attemptsInGeneration).toBe(0);
    await expect(
      h.publisher({
        objects: {
          ...h.app.objects,
          createPublication: async () => {
            throw new Error("sensitive SDK detail");
          },
        },
      })(event),
    ).rejects.toMatchObject({ message: "Publication delivery interrupted; retry or recover." });
  });
});

describe("publication transport markers", () => {
  it("builds self-contained Lambda archives exporting publication, jobs, and recovery handlers", async () => {
    await buildLab();
    const files = unzipSync(await readFile(new URL("../../dist/publication.zip", import.meta.url)));
    expect(Object.keys(files)).toEqual(["index.mjs"]);
    expect(strFromU8(files["index.mjs"]!)).toMatch(/export\s*\{[^}]*\bpublisher\b/s);
    const jobs = unzipSync(await readFile(new URL("../../dist/jobs.zip", import.meta.url)));
    expect(Object.keys(jobs)).toEqual(["index.mjs"]);
    expect(strFromU8(jobs["index.mjs"]!)).toMatch(/export\s*\{[^}]*\bscheduled\b/s);
    const recovery = unzipSync(await readFile(new URL("../../dist/recovery.zip", import.meta.url)));
    expect(Object.keys(recovery)).toEqual(["index.mjs"]);
    expect(strFromU8(recovery["index.mjs"]!)).toMatch(
      /export\s*\{[^}]*\bcollector\b[^}]*\bworker\b/s,
    );
  }, 30_000);
  async function setup() {
    const h = await publicationHarness();
    const markers = new Map<string, unknown>();
    const writes: unknown[] = [];
    let markerFailure = false;
    const client = {
      send: async (command: { input: unknown }) => {
        if (command instanceof GetItemCommand)
          return { Item: markers.get(JSON.stringify(command.input.Key)) };
        if (command instanceof PutItemCommand) {
          expect((await h.current()).state.status).toBe("published");
          if (markerFailure) throw new Error("marker unavailable");
          const item = command.input.Item!;
          const key = JSON.stringify({ PK: item.PK, SK: item.SK });
          markers.set(key, item);
          writes.push(unmarshall(item));
          return {};
        }
        throw new Error("Unexpected marker command");
      },
    };
    const queue = "arn:aws:sqs:us-east-1:000000000000:jawstack-content-ops-test-publication";
    const batch = () => ({
      Records: [
        {
          messageId: "message-1",
          eventSourceARN: queue,
          body: JSON.stringify(
            h.app.persistence.store.outbox.find(
              (e) => e.eventType === "contentItem.publicationRequested",
            ),
          ),
        },
      ],
    });
    const handler = (publisher = h.publisher()) =>
      createPublicationSqsHandler({
        client,
        tableName: "test",
        expectedQueueArn: queue,
        source: "content-operations",
        publisher,
        clock: h.clock.now,
      });
    return {
      ...h,
      handler,
      batch,
      markers,
      writes,
      failMarker: () => {
        markerFailure = true;
      },
      restoreMarker: () => {
        markerFailure = false;
      },
    };
  }
  it("marks only after completion and business-deduplicates after physical marker expiry", async () => {
    const h = await setup();
    expect(await h.handler()(h.batch())).toMatchObject({ processed: 1 });
    expect(await h.handler()(h.batch())).toMatchObject({ skipped: 1 });
    const row = await h.current();
    h.markers.clear();
    expect(await h.handler()(h.batch())).toMatchObject({ processed: 1 });
    expect(await h.current()).toEqual(row);
    expect(h.writes).toHaveLength(2);
  });
  it("recovers the domain-complete/marker-write failure gap", async () => {
    const h = await setup();
    h.failMarker();
    await expect(h.handler()(h.batch())).rejects.toMatchObject({ code: "runtime.unavailable" });
    expect(h.markers.size).toBe(0);
    const row = await h.current();
    h.restoreMarker();
    expect(await h.handler()(h.batch())).toMatchObject({ processed: 1 });
    expect(await h.current()).toEqual(row);
  });
  it("does not mark an interrupted or live-competing delivery", async () => {
    const h = await setup();
    const crash = h.publisher({
      fault: (point) => {
        if (point === "afterObjectWrite") throw new SimulatedPublicationCrash();
      },
    });
    await expect(h.handler(crash)(h.batch())).rejects.toBeInstanceOf(SimulatedPublicationCrash);
    await expect(h.handler()(h.batch())).rejects.toMatchObject({ code: "resource.conflict" });
    expect(h.markers.size).toBe(0);
    h.clock.advance(90_000);
    expect(await h.handler()(h.batch())).toMatchObject({ processed: 1 });
  });
  it("validates cached deliveries and the whole batch before marker lookup", async () => {
    const h = await setup();
    await h.handler()(h.batch());
    const record = h.batch().Records[0]!;
    for (const body of [
      "not-json",
      JSON.stringify({ ...JSON.parse(record.body), source: "foreign" }),
      JSON.stringify({ source: "foreign", detail: JSON.parse(record.body) }),
    ])
      await expect(h.handler()({ Records: [{ ...record, body }] })).rejects.toThrow();
    const foreignRecord = { ...record, eventSourceARN: "foreign" };
    await expect(h.handler()({ Records: [foreignRecord] })).rejects.toThrow();
    h.markers.clear();
    await expect(
      h.handler()({ Records: [record, { ...record, messageId: "bad-second", body: "not-json" }] }),
    ).rejects.toThrow();
    expect(h.markers.size).toBe(0);
    await h.handler()(h.batch());
    const envelope = JSON.parse(record.body);
    expect(
      await h.handler()({
        Records: [
          {
            ...record,
            body: JSON.stringify({
              source: "content-operations",
              "detail-type": envelope.eventType,
              detail: JSON.stringify(envelope),
            }),
          },
        ],
      }),
    ).toMatchObject({ skipped: 1 });
    expect(h.writes).toHaveLength(2);
  });
});

describe("publication byte contract", () => {
  it("sorts attachments by ID independently of source property/array order and preserves Unicode body bytes", async () => {
    const h = await publicationHarness();
    const attachments = [
      "00000000-0000-4000-8000-000000000002",
      "00000000-0000-4000-8000-000000000001",
    ].map((assetId) => ({
      assetId,
      contentId: h.contentId,
      filename: "proof.pdf",
      mediaType: "application/pdf" as const,
      size: 10,
      sha256: "a".repeat(64),
      objectKey: `assets/${h.contentId}/${assetId}/original`,
    }));
    const intent = {
      ...h.intent,
      snapshot: { ...h.intent.snapshot, body: "  \uFEFF\u00e9\n\u6f22\u5b57  ", attachments },
    };
    const first = serializePublication(intent);
    const reordered = Object.fromEntries(Object.entries(intent).reverse()) as typeof intent;
    expect(
      serializePublication({
        ...reordered,
        snapshot: { ...intent.snapshot, attachments: [...attachments].reverse() },
      }),
    ).toEqual(first);
    const parsed = JSON.parse(first.bytes.toString());
    expect(parsed.content.body).toBe(intent.snapshot.body);
    expect(parsed.content.attachments.map((a: { assetId: string }) => a.assetId)).toEqual(
      attachments.map((a) => a.assetId).sort(),
    );
    expect(parsed.requestedAt).toBe("2026-10-31T12:00:00.000Z");
  });
  it("has explicit ordered v1 UTF-8 JSON with a trailing LF and digest over the exact bytes", async () => {
    const h = await publicationHarness();
    const { bytes, reference } = serializePublication(h.intent);
    expect(Object.keys(JSON.parse(bytes.toString()))).toEqual([
      "schemaVersion",
      "publicationId",
      "contentId",
      "requestedAt",
      "approval",
      "schedule",
      "content",
    ]);
    expect(bytes.at(-1)).toBe(10);
    expect(reference.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(reference.size).toBe(bytes.length);
    expect(bytes.toString()).not.toMatch(/attempt|leaseUntil|fencingToken|completedAt/);
    expect(serializePublication(structuredClone(h.intent))).toEqual({ bytes, reference });
    expect(() => serializePublication({ ...h.intent, requestedAt: "not-a-date" })).toThrow(
      PublicationExecutionError,
    );
  });
});
