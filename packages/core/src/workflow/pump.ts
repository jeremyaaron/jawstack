import { AsyncLocalStorage } from "node:async_hooks";
import { JawStackRuntimeError, type JawStackEvent } from "../index";
import { envelopeFingerprint } from "./failure-records";
import { boundedWait } from "./runtime";
import type { createWorkflowDelivery } from "./delivery";
import { assertWorkflowWritable } from "./command-context";
import { instant, jsonCopy } from "./validation";

type Job = {
  consumer: string;
  event: JawStackEvent<Record<string, unknown>>;
  fingerprint: string;
  attempts: number;
  dueAt: number;
  status: "pending" | "failed";
};
export type WorkflowDrainResult = Readonly<{
  scanned: number;
  attempted: number;
  succeeded: number;
  retried: number;
  failed: number;
  ignored: number;
  collected: number;
  collectionFailed: number;
  deferred: number;
  pending: number;
  terminal: number;
  hasMore: boolean;
  backpressured: boolean;
  nextAttemptAt?: string;
}>;
export type WorkflowDrainUntilIdleResult = Readonly<{
  passes: number;
  idle: boolean;
  exhausted: boolean;
  result: WorkflowDrainResult;
}>;
export type WorkflowDriver = Readonly<{
  done: Promise<void>;
  stop(options?: { timeoutMs?: number }): Promise<void>;
}>;
const draining = /* @__PURE__ */ new AsyncLocalStorage<boolean>();
function wait(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });
}
export function createWorkflowPump(options: {
  outbox(): readonly JawStackEvent[];
  parse(input: unknown): JawStackEvent<Record<string, unknown>>;
  subscribers(eventType: string): readonly string[];
  delivery: ReturnType<typeof createWorkflowDelivery>;
  clock(): Date;
  signal: AbortSignal;
  maxJobs: number;
  markerCounts(): { delivery: number; collection: number };
  run<T>(work: () => T | Promise<T>): Promise<T>;
  check(): void;
}) {
  const jobs = new Map<string, Job>();
  const identity = (name: string, id: string) => JSON.stringify([name, id]);
  let cursor = 0,
    boundary: string | undefined,
    tail = Promise.resolve(),
    driver: WorkflowDriver | undefined;
  const time = () => Date.parse(instant(options.clock().toISOString()));
  const checkBoundary = () => {
    const rows = options.outbox();
    if (rows.length < cursor || (cursor > 0 && envelopeFingerprint(rows[cursor - 1]!) !== boundary))
      throw new JawStackRuntimeError(
        "resource.invalid_state",
        "Outbox changed beneath its pump; create a fresh runtime.",
      );
    return rows;
  };
  const pass = async (limit: number, signal: AbortSignal): Promise<WorkflowDrainResult> => {
    signal.throwIfAborted();
    const result = {
      scanned: 0,
      attempted: 0,
      succeeded: 0,
      retried: 0,
      failed: 0,
      ignored: 0,
      collected: 0,
      collectionFailed: 0,
      deferred: 0,
    };
    let blocked = false;
    checkBoundary();
    while (cursor < options.outbox().length && result.scanned < limit) {
      signal.throwIfAborted();
      const rows = checkBoundary(),
        raw = rows[cursor]!,
        rawFingerprint = envelopeFingerprint(raw);
      const event = options.parse(raw),
        fingerprint = envelopeFingerprint(event);
      const names = options.subscribers(event.eventType);
      // Authenticate even deduplicated or non-target fanout before considering markers/admission.
      const needed: Job[] = [];
      let ignored = 0;
      for (const name of names) {
        const key = identity(name, event.eventId),
          old = jobs.get(key);
        if (old && old.fingerprint !== fingerprint)
          throw new JawStackRuntimeError(
            "resource.conflict",
            "Transport identity was reused with different content.",
          );
        const state = await options.delivery.check(name, event);
        if (state === "ignored") ignored++;
        if (!old && state !== "ignored" && state !== "processed")
          needed.push({
            consumer: name,
            event: jsonCopy(event),
            fingerprint,
            attempts: 0,
            dueAt: time(),
            status: "pending",
          });
      }
      if (jobs.size + needed.length > options.maxJobs) {
        blocked = true;
        break;
      }
      if (options.outbox()[cursor] !== raw || envelopeFingerprint(raw) !== rawFingerprint)
        throw new JawStackRuntimeError(
          "resource.invalid_state",
          "Outbox changed during admission.",
        );
      for (const job of needed) jobs.set(identity(job.consumer, job.event.eventId), job);
      cursor++;
      boundary = envelopeFingerprint(raw);
      result.scanned++;
      result.ignored += ignored;
      if (!names.length) result.ignored++;
    }
    let work = 0;
    for (const [key, job] of jobs) {
      signal.throwIfAborted();
      if (work >= limit) break;
      if (job.status !== "pending" || job.dueAt > time()) continue;
      work++;
      result.attempted++;
      job.attempts++;
      try {
        const outcome = await options.delivery.handle(job.consumer, job.event, { signal });
        if (outcome.status === "deferred") {
          job.attempts--;
          job.dueAt = time() + 1000;
          result.deferred++;
          continue;
        }
        jobs.delete(key);
        if (outcome.status === "ignored") result.ignored++;
        else result.succeeded++;
      } catch {
        if (signal.aborted) {
          job.attempts--;
          signal.throwIfAborted();
        }
        if (job.attempts >= 3) {
          job.status = "failed";
          job.dueAt = time();
          result.failed++;
        } else {
          job.dueAt = time() + job.attempts * 1000;
          result.retried++;
        }
        // Job inspection never retains provider errors, stacks or payload fragments.
      }
    }
    for (const [key, job] of jobs) {
      signal.throwIfAborted();
      if (work >= limit) break;
      if (job.status !== "failed" || job.dueAt > time()) continue;
      work++;
      try {
        const outcome = await options.delivery.collect(job.consumer, job.event, { signal });
        if (outcome.status === "deferred") {
          result.deferred++;
          job.dueAt = time() + 1000;
          continue;
        }
        jobs.delete(key);
        result.collected++;
      } catch {
        signal.throwIfAborted();
        job.dueAt = time() + 1000;
        result.collectionFailed++;
      }
    }
    const pending = [...jobs.values()].filter((job) => job.status === "pending");
    const next = jobs.size ? Math.min(...[...jobs.values()].map((job) => job.dueAt)) : undefined;
    return {
      ...result,
      pending: pending.length,
      terminal: jobs.size - pending.length,
      hasMore:
        cursor < options.outbox().length || [...jobs.values()].some((job) => job.dueAt <= time()),
      backpressured: blocked,
      ...(next === undefined ? {} : { nextAttemptAt: new Date(next).toISOString() }),
    };
  };
  const drain = (limit = 50, signal = options.signal) => {
    assertWorkflowWritable();
    if (draining.getStore())
      throw new JawStackRuntimeError("command.rejected", "A handler cannot drain its own pump.");
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new JawStackRuntimeError("command.rejected", "Pump limit must be 1-100.");
    const activeSignal =
      signal === options.signal ? signal : AbortSignal.any([options.signal, signal]);
    return options.run(async () => {
      const previous = tail;
      let unlock!: () => void;
      tail = new Promise<void>((resolve) => {
        unlock = resolve;
      });
      await previous;
      try {
        return await draining.run(true, () => pass(limit, activeSignal));
      } finally {
        unlock();
      }
    });
  };
  const drainUntilIdle = async (
    input: { maxPasses?: number; limit?: number } = {},
  ): Promise<WorkflowDrainUntilIdleResult> => {
    const maximum = input.maxPasses ?? 20;
    if (!Number.isInteger(maximum) || maximum < 1 || maximum > 100)
      throw new JawStackRuntimeError("command.rejected", "Drain passes must be 1-100.");
    let result!: WorkflowDrainResult;
    for (let pass = 1; pass <= maximum; pass++) {
      result = await drain(input.limit ?? 50);
      const idle = !result.pending && !result.terminal && cursor >= options.outbox().length;
      if (idle || !result.hasMore || result.backpressured)
        return { passes: pass, idle, exhausted: false, result };
    }
    return { passes: maximum, idle: false, exhausted: true, result };
  };
  const start = (input: { intervalMs?: number } = {}): WorkflowDriver => {
    assertWorkflowWritable();
    options.check();
    if (draining.getStore())
      throw new JawStackRuntimeError("command.rejected", "A handler cannot start its own driver.");
    const interval = input.intervalMs ?? 1000;
    if (!Number.isInteger(interval) || interval < 1 || interval > 60000 || driver)
      throw new JawStackRuntimeError(
        "command.rejected",
        "Invalid interval or driver already running.",
      );
    const abort = new AbortController(),
      signal = AbortSignal.any([options.signal, abort.signal]);
    const done = (async () => {
      try {
        while (!signal.aborted) {
          await drain(50, signal);
          await wait(interval, signal);
        }
      } catch (error) {
        if (!signal.aborted) throw error;
      } finally {
        driver = undefined;
      }
    })();
    void done.catch(() => {});
    driver = Object.freeze({
      done,
      stop: (settings: { timeoutMs?: number } = {}) => {
        const result = boundedWait(done, settings.timeoutMs ?? 5000);
        abort.abort();
        return result;
      },
    });
    return driver;
  };
  return Object.freeze({
    drain,
    drainUntilIdle,
    start,
    stop: () => driver?.stop() ?? Promise.resolve(),
    inspect: () => ({
      cursor,
      markers: options.markerCounts(),
      jobs: [...jobs.values()].map((job) => ({
        consumer: job.consumer,
        eventId: job.event.eventId,
        attempts: job.attempts,
        status: job.status,
        dueAt: new Date(job.dueAt).toISOString(),
      })),
    }),
  });
}
