import { createHash } from "node:crypto";
import {
  JawStackRuntimeError,
  type ResourceRepository,
  type QueryRepository,
  type ProjectionRecord,
} from "@jawstack/core";
import { contentStateSchema } from "../shared/contracts";
import { limits, versionSchema, instantSchema } from "../shared/validation";
import { dueWorkerIdentity } from "../domain/publication-commands";
import { assetJanitorIdentity } from "../domain/resources";
import { cleanupTargetSchema, type AssetCleanupStore } from "./asset-cleanup";
import {
  assertJobLease,
  jobNameSchema,
  type JobName,
  type JobStore,
  type JobProgress,
} from "./job-store";
import type { createContentDispatch } from "./dispatch";

const projections: Record<JobName, string> = {
  duePublication: "contentItem.duePublication",
  dueReview: "contentItem.dueReview",
  expireUploads: "contentItem.expiringUploads",
  cleanupOrphans: "contentItem.orphanAssets",
};
class JobBudgetExceeded extends Error {}
export function createContentJobs(options: {
  repository: ResourceRepository & QueryRepository;
  dispatch: ReturnType<typeof createContentDispatch>;
  store: JobStore;
  objects: AssetCleanupStore;
  clock?: () => Date;
  monotonic?: () => number;
}) {
  const clock = options.clock ?? (() => new Date());
  const monotonic = options.monotonic ?? (() => performance.now());
  const load = async (contentId: string) => {
    const row = await options.repository.getState("contentItem", contentId);
    if (!row) return undefined;
    const state = contentStateSchema.safeParse(row.state);
    if (
      !state.success ||
      row.resourceType !== "contentItem" ||
      row.resourceId !== contentId ||
      state.data.contentId !== contentId ||
      !versionSchema.safeParse(row.version).success ||
      !instantSchema.safeParse(row.createdAt).success ||
      !instantSchema.safeParse(row.updatedAt).success
    )
      throw new JawStackRuntimeError(
        "resource.invalid_state",
        "Invalid authoritative job candidate.",
      );
    return { ...row, state: state.data };
  };
  const process = async (
    name: JobName,
    candidate: ProjectionRecord,
    cutoff: string,
    guard: () => void,
  ) => {
    const contentId = candidate.itemId;
    const row = await load(contentId);
    if (!row) return false;
    const state = row.state;
    const now = clock().toISOString();
    let commandName: string;
    let input: Record<string, unknown>;
    let identity: { subject: string; role: string } = dueWorkerIdentity;
    if (name === "duePublication") {
      const schedule = state.schedule;
      if (
        state.status !== "scheduled" ||
        !schedule ||
        schedule.scheduledAt > cutoff ||
        schedule.scheduledAt > now ||
        candidate.data.generation !== schedule.generation ||
        candidate.data.revisionId !== state.revisionId ||
        candidate.data.scheduledAt !== schedule.scheduledAt
      )
        return false;
      commandName = "requestDuePublication";
      input = {
        expectedVersion: row.version,
        revisionId: state.revisionId,
        scheduleGeneration: schedule.generation,
      };
    } else if (name === "dueReview") {
      const review = state.review;
      if (
        state.status !== "inReview" ||
        review?.status !== "pending" ||
        review.dueAt > cutoff ||
        review.dueAt > now ||
        candidate.data.reviewId !== review.reviewId ||
        candidate.data.revisionId !== state.revisionId ||
        candidate.data.dueAt !== review.dueAt ||
        (review.lastReminderDay && review.lastReminderDay >= now.slice(0, 10))
      )
        return false;
      commandName = "recordReviewReminder";
      input = {
        expectedVersion: row.version,
        reviewId: review.reviewId,
        revisionId: state.revisionId,
      };
    } else {
      const target = cleanupTargetSchema.parse({ contentId, assetId: candidate.data.assetId });
      const slot = state.attachments.find((a) => a.assetId === target.assetId);
      if (!slot) return false;
      if (name === "expireUploads") {
        if (
          state.status !== "draft" ||
          slot.status !== "pending" ||
          slot.uploadExpiresAt > cutoff ||
          slot.uploadExpiresAt > now
        )
          return false;
        commandName = "expireAsset";
        input = { expectedVersion: row.version, assetId: slot.assetId };
        identity = assetJanitorIdentity;
      } else {
        const olderThan = new Date(
          Math.min(Date.parse(cutoff), Date.parse(now)) - limits.orphanAgeMs,
        ).toISOString();
        const eligible = (current: typeof state) => {
          const currentSlot = current.attachments.find((a) => a.assetId === target.assetId);
          return (
            current.status !== "archived" &&
            currentSlot &&
            ["removed", "expired"].includes(currentSlot.status) &&
            currentSlot.verified === null &&
            currentSlot.retiredAt !== null &&
            currentSlot.retiredAt <= olderThan &&
            !current.review?.submitted.attachments.some((a) => a.assetId === target.assetId) &&
            !current.publication?.intent.snapshot.attachments.some(
              (a) => a.assetId === target.assetId,
            )
          );
        };
        if (!eligible(state)) return false;
        const observed = await options.objects.inspectAssetObject(target);
        if (!observed || observed.lastModified > olderThan) return false;
        const latest = await load(contentId);
        if (!latest || !eligible(latest.state)) return false;
        guard();
        return options.objects.deleteAssetObject(target, observed, olderThan);
      }
    }
    guard();
    const key = createHash("sha256")
      .update(JSON.stringify([name, contentId, input, now.slice(0, 10)]))
      .digest("hex");
    const result = await options.dispatch(
      {
        resourceType: "contentItem",
        resourceId: contentId,
        commandName,
        input,
        idempotencyKey: `job:${key}`,
        requestContext: {},
      },
      { subject: identity.subject, roles: [identity.role], mode: "dev", claims: {} },
    );
    if (!result.ok) throw new JawStackRuntimeError(result.error.code, result.error.message);
    return true;
  };
  return {
    tick: async (name: JobName, budget: { maxItems?: number; maxMs?: number } = {}) => {
      jobNameSchema.parse(name);
      const maxItems = budget.maxItems ?? 50;
      const maxMs = budget.maxMs ?? 20_000;
      if (
        !Number.isInteger(maxItems) ||
        maxItems < 1 ||
        maxItems > 50 ||
        !Number.isFinite(maxMs) ||
        maxMs < 1 ||
        maxMs > 20_000
      )
        throw new Error("Invalid job budget.");
      const start = monotonic();
      const lease = await options.store.acquire(name, clock());
      const result = {
        status: "busy" as "busy" | "completed" | "yielded",
        examined: 0,
        succeeded: 0,
        ignored: 0,
        failures: [] as { itemId: string; code: string }[],
      };
      if (!lease) return result;
      let progress: JobProgress = { ...lease.progress };
      const guard = () => {
        assertJobLease(lease, clock());
        if (monotonic() - start >= maxMs) throw new JobBudgetExceeded();
      };
      try {
        if (!progress.passCutoff) {
          progress = { passCutoff: clock().toISOString(), cursor: null };
          await options.store.save(lease, progress, clock());
        }
        while (result.examined < maxItems && monotonic() - start < maxMs) {
          assertJobLease(lease, clock());
          const cutoff = progress.passCutoff!;
          const bound =
            name === "cleanupOrphans"
              ? new Date(Date.parse(cutoff) - limits.orphanAgeMs).toISOString()
              : cutoff;
          const page = await options.repository.queryProjection({
            projectionName: projections[name],
            sortBefore: `${bound}~`,
            limit: 1,
            ...(progress.cursor ? { cursor: progress.cursor } : {}),
          });
          if (monotonic() - start >= maxMs) break;
          if (page.items.length > 1)
            throw new JawStackRuntimeError(
              "runtime.unavailable",
              "Job query exceeded its candidate budget.",
            );
          // A service-shortened empty page still consumes work and advances its continuation.
          result.examined++;
          for (const candidate of page.items) {
            try {
              if (await process(name, candidate, cutoff, guard)) result.succeeded++;
              else result.ignored++;
            } catch (error) {
              if (error instanceof JobBudgetExceeded) {
                result.status = "yielded";
                return result;
              }
              result.failures.push({
                itemId: candidate.itemId,
                code: error instanceof JawStackRuntimeError ? error.code : "runtime.unavailable",
              });
            }
          }
          progress = page.nextCursor
            ? { passCutoff: cutoff, cursor: page.nextCursor }
            : { passCutoff: null, cursor: null };
          await options.store.save(lease, progress, clock());
          if (!progress.passCutoff) {
            result.status = "completed";
            break;
          }
        }
        if (result.status !== "completed") result.status = "yielded";
        return result;
      } catch (error) {
        if (error instanceof JawStackRuntimeError) throw error;
        throw new JawStackRuntimeError("runtime.unavailable", "Job tick dependency failed.");
      } finally {
        // An expired/lost lease must never release or overwrite its successor's checkpoint.
        if (clock().toISOString() >= lease.startedAt && clock().toISOString() < lease.leaseUntil)
          await options.store.save(lease, progress, clock(), true);
      }
    },
  };
}
