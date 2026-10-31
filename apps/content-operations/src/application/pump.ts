import { createHash } from "node:crypto";
import { JawStackRuntimeError, type JawStackEvent, type RuntimeErrorCode } from "@jawstack/core";
import type { ContentWorkerName } from "../domain/subscriptions";
import { jsonBytes, limits } from "../shared/validation";
import type { createContentWorkers } from "./workers";

export const workerMarkerTtlMs = 7 * 24 * 60 * 60 * 1000;
type Job = {
  worker: ContentWorkerName;
  event: JawStackEvent;
  attempts: number;
  dueAt: number;
  status: "pending" | "failed";
  error?: { code: RuntimeErrorCode; message: string };
};
const identity = (name: string, eventId: string) => JSON.stringify([name, eventId]);
const fingerprint = (event: JawStackEvent) =>
  createHash("sha256").update(JSON.stringify(event)).digest("hex");

export function createMemoryPump(options: {
  outbox: () => readonly JawStackEvent[];
  workers: Pick<ReturnType<typeof createContentWorkers>, "subscribers" | "handle">;
  clock?: () => Date;
  maxJobs?: number;
  maxMarkers?: number;
}) {
  const maxJobs = options.maxJobs ?? 200;
  const maxMarkers = options.maxMarkers ?? 1000;
  for (const value of [maxJobs, maxMarkers])
    if (!Number.isSafeInteger(value) || value < 1 || value > 10_000)
      throw new Error("Invalid memory pump capacity.");
  const jobs = new Map<string, Job>();
  const markers = new Map<string, { fingerprint: string; expiresAt: number }>();
  let cursor = 0;
  let tail = Promise.resolve();
  const drain = async (limit = 50) => {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new Error("Pump limit must be 1-100.");
    const previous = tail;
    let unlock!: () => void;
    tail = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    await previous;
    try {
      const now = (options.clock?.() ?? new Date()).getTime();
      for (const [key, marker] of markers) if (marker.expiresAt <= now) markers.delete(key);
      const result = { scanned: 0, attempted: 0, succeeded: 0, retried: 0, failed: 0, ignored: 0 };
      let blockedNeeded = 0;
      const outbox = options.outbox();
      if (outbox.length < cursor)
        throw new JawStackRuntimeError(
          "resource.invalid_state",
          "Outbox was reset beneath its pump; create a fresh memory runtime.",
        );
      while (cursor < outbox.length && result.scanned < limit) {
        const event = outbox[cursor]!;
        if (jsonBytes(event) > limits.eventBytes + 4096)
          throw new JawStackRuntimeError(
            "command.validation",
            "Committed outbox event exceeds its budget.",
          );
        const names = options.workers.subscribers(event.eventType);
        const needed = names.filter(
          (name) =>
            !jobs.has(identity(name, event.eventId)) && !markers.has(identity(name, event.eventId)),
        );
        if (jobs.size + needed.length > maxJobs) {
          blockedNeeded = needed.length;
          break;
        }
        const hash = fingerprint(event);
        for (const name of names) {
          const key = identity(name, event.eventId);
          const marker = markers.get(key);
          const job = jobs.get(key);
          if ((marker && marker.fingerprint !== hash) || (job && fingerprint(job.event) !== hash))
            throw new JawStackRuntimeError(
              "resource.conflict",
              "Transport event ID was reused with different content.",
            );
          if (!marker && !job)
            jobs.set(key, {
              worker: name,
              event: structuredClone(event),
              attempts: 0,
              dueAt: now,
              status: "pending",
            });
        }
        if (!names.length) result.ignored++;
        cursor++;
        result.scanned++;
      }
      for (const [key, job] of jobs) {
        if (result.attempted >= limit) break;
        if (job.status !== "pending" || job.dueAt > now) continue;
        result.attempted++;
        job.attempts++;
        try {
          await options.workers.handle(job.worker, structuredClone(job.event));
          jobs.delete(key);
          markers.set(key, {
            fingerprint: fingerprint(job.event),
            expiresAt: now + workerMarkerTtlMs,
          });
          if (markers.size > maxMarkers) markers.delete(markers.keys().next().value!);
          result.succeeded++;
        } catch (error) {
          // Never persist exception messages, payload fragments, or stacks in operational state.
          job.error = {
            code: error instanceof JawStackRuntimeError ? error.code : "runtime.unavailable",
            message: "Application worker failed.",
          };
          if (job.attempts >= 3) {
            job.status = "failed";
            result.failed++;
          } else {
            job.dueAt = now + 1000 * job.attempts;
            result.retried++;
          }
        }
      }
      const pending = [...jobs.values()].filter((job) => job.status === "pending");
      const next = pending.length ? Math.min(...pending.map((job) => job.dueAt)) : undefined;
      return {
        ...result,
        pending: pending.length,
        terminal: jobs.size - pending.length,
        hasMore: cursor < options.outbox().length || pending.some((job) => job.dueAt <= now),
        ...(next === undefined ? {} : { nextAttemptAt: new Date(next).toISOString() }),
        backpressured: blockedNeeded > 0 && jobs.size + blockedNeeded > maxJobs,
      };
    } finally {
      unlock();
    }
  };
  return {
    drain,
    inspect: () => ({
      cursor,
      markers: markers.size,
      jobs: [...jobs.values()].map((job) => ({
        worker: job.worker,
        eventId: job.event.eventId,
        attempts: job.attempts,
        status: job.status,
        dueAt: new Date(job.dueAt).toISOString(),
        ...(job.error ? { error: { ...job.error } } : {}),
      })),
    }),
  };
}
