import { JawStackRuntimeError } from "../index";

export const workflowCommitLimits = Object.freeze({
  actions: 60,
  recordBytes: 192 * 1024,
  auxiliaryBytes: 64 * 1024,
  planBytes: 1024 * 1024,
  jsonDepth: 16,
  jsonNodes: 10_000,
  logicalKeyBytes: 1024,
  idempotencyTtlSeconds: 604800,
});

export type WorkflowReadonly<T> = T extends readonly (infer U)[]
  ? readonly WorkflowReadonly<U>[]
  : T extends object
    ? { readonly [K in keyof T]: WorkflowReadonly<T[K]> }
    : T;

export function reject(message: string): never {
  throw new JawStackRuntimeError("command.rejected", message);
}

export function synchronous<T>(value: T): T {
  if (typeof value === "object" && value !== null && value instanceof Promise) {
    void value.catch(() => {});
    reject("Workflow contribution functions must be synchronous.");
  }
  return value;
}

export function component(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.:-]{1,200}$/.test(value))
    reject("Invalid workflow identity component.");
  return value;
}

export function utf8(value: unknown, maximum: number): string {
  if (
    typeof value !== "string" ||
    !value.length ||
    Buffer.byteLength(value) > maximum ||
    Buffer.from(value).toString("utf8") !== value
  )
    reject("Invalid workflow text/key bounds.");
  return value;
}

export function instant(value: unknown): string {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value ||
    Date.parse(value) < 0
  )
    reject("Expected a canonical workflow UTC instant.");
  return value;
}

export function plainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value))
  );
}

export function jsonCopy<T>(value: T, maximum = workflowCommitLimits.planBytes): T {
  let nodes = 0;
  let bytes = 0;
  const addBytes = (count: number) => {
    bytes += count;
    if (bytes > maximum) reject("Workflow JSON exceeds its byte budget.");
  };
  const stringBytes = (text: string) => {
    if (text.length > maximum || Buffer.byteLength(text) > maximum)
      reject("Workflow JSON exceeds its byte budget.");
    if (Buffer.from(text).toString("utf8") !== text) reject("Invalid workflow JSON text bounds.");
    return Buffer.byteLength(JSON.stringify(text));
  };
  const ancestors = new Set<object>();
  const visit = (item: unknown, depth: number): void => {
    if (++nodes > workflowCommitLimits.jsonNodes || depth > workflowCommitLimits.jsonDepth)
      reject("Workflow JSON exceeds depth/node bounds.");
    if (item === null || typeof item === "boolean") {
      addBytes(item === null ? 4 : item ? 4 : 5);
      return;
    }
    if (typeof item === "number") {
      if (!Number.isFinite(item)) reject("Workflow JSON requires finite numbers.");
      addBytes(JSON.stringify(item).length);
      return;
    }
    if (typeof item === "string") {
      addBytes(stringBytes(item));
      return;
    }
    if (
      typeof item !== "object" ||
      (!Array.isArray(item) && !plainObject(item)) ||
      ancestors.has(item)
    )
      reject("Expected finite plain workflow JSON.");
    ancestors.add(item);
    addBytes(2);
    if (Array.isArray(item) && item.length > workflowCommitLimits.jsonNodes)
      reject("Workflow JSON exceeds node bounds.");
    const keys = Reflect.ownKeys(item);
    if (
      Array.isArray(item) &&
      (Object.getPrototypeOf(item) !== Array.prototype ||
        keys.length !== item.length + 1 ||
        item.length > workflowCommitLimits.jsonNodes)
    )
      reject("Sparse or extended arrays are not workflow JSON.");
    let entries = 0;
    for (const key of keys) {
      if (Array.isArray(item) && key === "length") continue;
      if (
        Array.isArray(item) &&
        (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= item.length)
      )
        reject("Extended arrays are not workflow JSON.");
      const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
      if (typeof key !== "string" || !descriptor.enumerable || !("value" in descriptor))
        reject("Workflow JSON cannot contain symbols, accessors or hidden properties.");
      if (entries++) addBytes(1);
      if (!Array.isArray(item)) addBytes(stringBytes(key) + 1);
      visit(descriptor.value, depth + 1);
    }
    ancestors.delete(item);
  };
  visit(value, 0);
  const encoded = JSON.stringify(value);
  return JSON.parse(encoded) as T;
}

export function freeze<T>(value: T): WorkflowReadonly<T> {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value as WorkflowReadonly<T>;
}
