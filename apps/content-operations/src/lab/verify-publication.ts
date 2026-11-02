import { randomUUID } from "node:crypto";
import { ListObjectsV2Command, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { DynamoDbRepository } from "@jawstack/aws-runtime";
import { createDynamoPersistence } from "../aws/persistence";
import { createLocalS3ObjectStore } from "../aws/object-store";
import { createContentDispatch } from "../application/dispatch";
import { createPublisher, SimulatedPublicationCrash } from "../application/publisher";
import { serializePublication } from "../application/publication-artifact";
import { createFixtureClock } from "../application/runtime";
import { parseContentEvent } from "../shared/events";
import { fixtureAuth } from "../shared/identities";
import type { ContentState } from "../shared/contracts";
import { LabError, type LabConfig } from "./config";
import type { LabClients } from "./clients";

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new LabError(`Publication proof: ${message}`);
}
export async function verifyPublication(clients: LabClients, config: LabConfig) {
  const runId = randomUUID();
  const clock = createFixtureClock(new Date().toISOString());
  const repository = new DynamoDbRepository({ client: clients.dynamo, tableName: config.table });
  const objects = createLocalS3ObjectStore(config);
  const factory = createDynamoPersistence({
    client: clients.dynamo,
    tableName: config.table,
    source: config.source,
  });
  const requests: unknown[] = [];
  const dispatch = createContentDispatch({
    clock: clock.now,
    source: config.source,
    persistence: (scope, now) => {
      const persistence = factory(scope, now);
      return {
        ...persistence,
        unitOfWork: {
          commit: async (input) => {
            await persistence.unitOfWork.commit(input);
            requests.push(
              ...input.outbox.filter((e) => e.eventType === "contentItem.publicationRequested"),
            );
          },
        },
      };
    },
  });
  let sequence = 0;
  async function setup() {
    const contentId = randomUUID();
    const current = async () =>
      (await repository.getState<ContentState>("contentItem", contentId))!;
    const run = (commandName: string, input: unknown, editor = false) =>
      dispatch(
        {
          resourceType: "contentItem",
          resourceId: contentId,
          commandName,
          input,
          idempotencyKey: `publication-proof:${runId}:${++sequence}`,
          requestContext: {},
        },
        fixtureAuth(editor ? "editor_1" : "author_1"),
      );
    check(
      (
        await run("create", {
          title: "Recoverable publication proof",
          body: "Frozen intent on local S3",
        })
      ).ok,
      "create failed",
    );
    check(
      (
        await run("submit", {
          expectedVersion: 1,
          assignedEditorId: "editor_1",
          dueAt: new Date(clock.now().getTime() + 86_400_000).toISOString(),
        })
      ).ok,
      "submit failed",
    );
    const submitted = await current();
    check(
      (
        await run(
          "approve",
          {
            expectedVersion: submitted.version,
            reviewId: submitted.state.review!.reviewId,
            revisionId: submitted.state.revisionId,
            note: "Approved",
          },
          true,
        )
      ).ok,
      "approve failed",
    );
    const approved = await current();
    check(
      (
        await run(
          "publishNow",
          {
            expectedVersion: approved.version,
            reviewId: approved.state.approval!.reviewId,
            revisionId: approved.state.revisionId,
          },
          true,
        )
      ).ok,
      "request failed",
    );
    const intent = (await current()).state.publication!.intent;
    const event = parseContentEvent(requests.at(-1), config.source);
    return { contentId, current, intent, event };
  }
  try {
    const h = await setup();
    const worker = createPublisher({ repository, dispatch, objects, clock: clock.now });
    let interrupted = false;
    try {
      await createPublisher({
        repository,
        dispatch,
        objects,
        clock: clock.now,
        fault: (point) => {
          if (point === "afterObjectWrite") throw new SimulatedPublicationCrash();
        },
      })(h.event);
    } catch (error) {
      if (error instanceof SimulatedPublicationCrash) interrupted = true;
      else throw error;
    }
    check(
      interrupted && (await h.current()).state.publication!.phase === "running",
      "crash did not retain claim",
    );
    const expected = serializePublication(h.intent);
    check(
      Buffer.from(await objects.readPublication(h.intent)).equals(expected.bytes),
      "object not durable before completion",
    );
    let competing = false;
    try {
      await worker(h.event);
    } catch (error) {
      competing = error instanceof Error && "code" in error && error.code === "resource.conflict";
    }
    check(competing, "live claim was acknowledged");
    clock.advance(90_000);
    check((await worker(h.event)) === "published", "lease recovery failed");
    const completed = await h.current();
    check(
      completed.state.status === "published" &&
        completed.state.publication!.artifact?.sha256 === expected.reference.sha256,
      "domain completion mismatch",
    );
    const history = await repository.listProjection(
      `contentItem.publicationAttempts.${h.contentId}`,
    );
    check(
      history.length === 2 &&
        history.some(
          (row) => (row.data as { attempt: { status: string } }).attempt.status === "expired",
        ) &&
        history.some(
          (row) => (row.data as { attempt: { status: string } }).attempt.status === "succeeded",
        ),
      "attempt history missing",
    );
    check(
      (await worker(h.event)) === "alreadyPublished" &&
        (await h.current()).version === completed.version,
      "duplicate changed completed state",
    );
    const listed = await clients.s3.send(
      new ListObjectsV2Command({ Bucket: config.bucket, Prefix: `publications/${h.contentId}/` }),
    );
    check(listed.Contents?.length === 1, "multiple logical artifacts");

    const corrupt = await setup();
    const corruptExpected = serializePublication(corrupt.intent);
    const badBytes = Buffer.from(corruptExpected.bytes);
    badBytes[0] = 0;
    // Private lab injection targets one exact owned key, never a public application endpoint.
    await clients.s3.send(
      new PutObjectCommand({
        Bucket: config.bucket,
        Key: corruptExpected.reference.objectKey,
        Body: badBytes,
        ContentType: "application/json",
        Metadata: {
          sha256: corruptExpected.reference.sha256,
          contentid: corrupt.contentId,
          publicationid: corrupt.intent.publicationId,
        },
        IfNoneMatch: "*",
      }),
    );
    let rejected = false;
    try {
      await worker(corrupt.event);
    } catch (error) {
      rejected =
        error instanceof Error &&
        "failureCode" in error &&
        error.failureCode === "artifact.mismatch";
    }
    check(
      rejected && (await corrupt.current()).state.publication!.phase === "failed",
      "corrupt object not terminal",
    );
    const unchanged = await clients.s3.send(
      new GetObjectCommand({ Bucket: config.bucket, Key: corruptExpected.reference.objectKey }),
    );
    check(
      unchanged.Body && Buffer.from(await unchanged.Body.transformToByteArray()).equals(badBytes),
      "corrupt object overwritten",
    );
    return {
      runId,
      contentId: h.contentId,
      mode: "shared publisher directly on real DynamoDB/S3; not deployed consumer SQS route",
      stableArtifactDigest: expected.reference.sha256,
      logicalArtifacts: 1,
      crashAfterObjectRecovered: true,
      liveClaimRejected: true,
      expiredAndSucceededHistory: true,
      completedDuplicateNoMutation: true,
      corruptObjectTerminalWithoutOverwrite: true,
    };
  } finally {
    objects.close();
  }
}
