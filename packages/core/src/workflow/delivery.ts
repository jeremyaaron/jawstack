import { JawStackDefinitionError, JawStackRuntimeError, type JawStackEvent } from "../index";
import { envelopeFingerprint, recoveryMetadataSchema } from "./failure-records";
import type { createWorkflowFailureService } from "./failures";
import { workflowDefinition, type WorkflowDefinition } from "./definition";
import type { WorkflowConsumerBinding, WorkflowDeliveryEvent } from "./runtime";
import { freeze, instant, jsonCopy } from "./validation";
import { assertWorkflowWritable } from "./command-context";
import { invalidStored } from "./stored";

export type WorkflowMarkerStore = Readonly<{
  check(
    consumer: string,
    event: JawStackEvent,
    now: Date,
  ): Promise<"processed" | "available" | "full">;
  write(consumer: string, event: JawStackEvent, now: Date): Promise<void>;
}>;
export type WorkflowDeliveryResult = Readonly<{
  status: "processed" | "duplicate" | "ignored" | "deferred";
}>;
export function createWorkflowDelivery(options: {
  definition: WorkflowDefinition;
  failures: Pick<
    ReturnType<typeof createWorkflowFailureService>,
    "authorize" | "validateCollection" | "complete" | "collect"
  >;
  markers: WorkflowMarkerStore;
  bindings: ReadonlyMap<string, WorkflowConsumerBinding>;
  clock: () => Date;
  signal: AbortSignal;
  run<T>(work: () => T | Promise<T>): Promise<T>;
}) {
  const { failures, markers, clock, run } = options;
  const data = workflowDefinition(options.definition);
  const bindings = new Map(options.bindings);
  if (
    bindings.size !== data.consumers.length ||
    [...bindings].some(
      ([name, binding]) =>
        !data.consumers.some((consumer) => consumer.name === name) ||
        typeof binding?.handle !== "function",
    ) ||
    [
      clock,
      run,
      markers?.check,
      markers?.write,
      failures?.authorize,
      failures?.validateCollection,
      failures?.complete,
      failures?.collect,
    ].some((callback) => typeof callback !== "function") ||
    !(options.signal instanceof AbortSignal)
  )
    throw new JawStackDefinitionError(
      "workflow.delivery",
      "Complete owned consumer bindings and delivery ports are required.",
    );
  for (const [name, binding] of bindings) bindings.set(name, Object.freeze({ ...binding }));
  const validate = async (consumer: string, input: unknown, collection = false) => {
    const wire = data.parse(input);
    data.protocol.subscription(consumer, wire);
    let target = true;
    if ("delivery" in wire.payload)
      target = (await failures.authorize(consumer, wire, true)).target;
    if (collection && target) await failures.validateCollection(consumer, wire);
    return { wire, target };
  };
  const signalFor = (signal?: AbortSignal) =>
    signal ? AbortSignal.any([options.signal, signal]) : options.signal;
  const handle = (
    consumer: string,
    input: unknown,
    inputOptions: { signal?: AbortSignal } = {},
  ): Promise<WorkflowDeliveryResult> => {
    assertWorkflowWritable();
    return run(async () => {
      const signal = signalFor(inputOptions.signal);
      signal.throwIfAborted();
      const { wire, target } = await validate(consumer, input);
      if (!target) return { status: "ignored" };
      const marker = await markers.check(consumer, wire, new Date(clock().getTime()));
      if (marker === "processed") return { status: "duplicate" };
      if (marker === "full") return { status: "deferred" };
      if (marker !== "available") invalidStored();
      signal.throwIfAborted();
      const { delivery, ...payload } = wire.payload;
      const recovery = delivery === undefined ? undefined : recoveryMetadataSchema.parse(delivery);
      const event: WorkflowDeliveryEvent = {
        ...wire,
        payload,
        originalEventId: recovery?.originalEventId ?? wire.eventId,
        ...(recovery ? { recovery } : {}),
      };
      const outcome = await bindings.get(consumer)!.handle(freeze(jsonCopy(event)), { signal });
      if (outcome !== undefined && outcome !== "ignored")
        throw new JawStackRuntimeError("runtime.unavailable", "Invalid business handler outcome.");
      signal.throwIfAborted();
      if (recovery) await failures.complete(consumer, wire);
      await markers.write(consumer, wire, new Date(clock().getTime()));
      return { status: outcome === "ignored" ? "ignored" : "processed" };
    });
  };
  const collect = (
    consumer: string,
    input: unknown,
    inputOptions: { signal?: AbortSignal } = {},
  ): Promise<WorkflowDeliveryResult> => {
    assertWorkflowWritable();
    return run(async () => {
      const signal = signalFor(inputOptions.signal);
      signal.throwIfAborted();
      const { wire, target } = await validate(consumer, input, true);
      if (!target) return { status: "ignored" };
      const name = `collectFailure.${consumer}`;
      const marker = await markers.check(name, wire, new Date(clock().getTime()));
      if (marker === "processed") return { status: "duplicate" };
      if (marker === "full") return { status: "deferred" };
      if (marker !== "available") invalidStored();
      signal.throwIfAborted();
      await failures.collect(consumer, wire);
      signal.throwIfAborted();
      await markers.write(name, wire, new Date(clock().getTime()));
      return { status: "processed" };
    });
  };
  return Object.freeze({
    check: (consumer: string, input: unknown) =>
      run(async () => {
        const { wire, target } = await validate(consumer, input);
        if (!target) return "ignored" as const;
        const status = await markers.check(consumer, wire, new Date(clock().getTime()));
        const collection = await markers.check(
          `collectFailure.${consumer}`,
          wire,
          new Date(clock().getTime()),
        );
        if (
          [status, collection].some((value) => !["processed", "available", "full"].includes(value))
        )
          invalidStored();
        return collection === "processed" ? "processed" : status;
      }),
    validate: (consumer: string, input: unknown) =>
      run(() => validate(consumer, input).then(() => undefined)),
    validateCollection: (consumer: string, input: unknown) =>
      run(() => validate(consumer, input, true).then(() => undefined)),
    handle,
    collect,
  });
}
export function createMemoryWorkflowMarkers(
  maximum: number,
  collectionMaximum: number,
): WorkflowMarkerStore & { inspect(now: Date): { delivery: number; collection: number } } {
  if (
    [maximum, collectionMaximum].some(
      (value) => !Number.isInteger(value) || value < 1 || value > 10000,
    )
  )
    throw new JawStackDefinitionError("workflow.memory", "Marker capacities must be 1-10000.");
  const maps = [
    new Map<string, { fingerprint: string; expiresAt: number }>(),
    new Map<string, { fingerprint: string; expiresAt: number }>(),
  ];
  const access = (consumer: string, event: JawStackEvent, now: Date) => {
    const time = Date.parse(instant(now.toISOString())),
      collection = consumer.startsWith("collectFailure.");
    const map = maps[collection ? 1 : 0]!;
    for (const [key, row] of map) if (row.expiresAt <= time) map.delete(key);
    const key = JSON.stringify([consumer, event.eventId]),
      fingerprint = envelopeFingerprint(event),
      old = map.get(key);
    if (old && old.fingerprint !== fingerprint)
      throw new JawStackRuntimeError(
        "resource.conflict",
        "Transport identity was reused with different content.",
      );
    return { map, key, fingerprint, time, old, maximum: collection ? collectionMaximum : maximum };
  };
  return Object.freeze<
    WorkflowMarkerStore & { inspect(now: Date): { delivery: number; collection: number } }
  >({
    check: async (consumer, event, now) => {
      const row = access(consumer, event, now);
      return row.old ? "processed" : row.map.size >= row.maximum ? "full" : "available";
    },
    write: async (consumer, event, now) => {
      const row = access(consumer, event, now);
      if (!row.old && row.map.size >= row.maximum)
        throw new JawStackRuntimeError(
          "runtime.unavailable",
          "Processing marker capacity reached.",
        );
      row.map.set(row.key, { fingerprint: row.fingerprint, expiresAt: row.time + 604800000 });
    },
    inspect: (now) => {
      for (const map of maps)
        for (const [key, row] of map) if (row.expiresAt <= now.getTime()) map.delete(key);
      return { delivery: maps[0]!.size, collection: maps[1]!.size };
    },
  });
}
