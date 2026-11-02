import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { JawStackDefinitionError } from "../index";
import {
  component,
  freeze,
  jsonCopy,
  plainObject,
  reject,
  synchronous,
  utf8,
  workflowCommitLimits,
  type WorkflowReadonly,
} from "./validation";

declare const recordBrand: unique symbol;
declare const createBrand: unique symbol;
export type AtomicRecordOwner = Readonly<{ resourceType: string; resourceId: string }>;
export interface AtomicRecordDefinition<T = unknown> {
  readonly [recordBrand]: true;
  readonly name: string;
  create(value: T): AtomicRecordCreate;
}
export type AtomicRecordCreate = Readonly<{ [createBrand]: true }>;
type Definition = {
  name: string;
  parse(value: unknown): unknown;
  key(value: unknown): string;
  owner(value: unknown): AtomicRecordOwner;
};
const definitions = new WeakMap<object, Definition>();
const creates = new WeakMap<object, { definition: object; value: unknown }>();

export function collectionName(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[a-z][A-Za-z0-9_.:-]{0,99}$/.test(value) ||
    /^(res|act|outbox|idemp|proj|worker|failure|jawstack)([.:-]|$)/i.test(value)
  )
    reject("Invalid or reserved atomic record collection.");
  return value;
}

export function defineAtomicRecord<T>(options: {
  name: string;
  schema: z.ZodType<T>;
  key(value: WorkflowReadonly<T>): string;
  owner(value: WorkflowReadonly<T>): AtomicRecordOwner;
}): AtomicRecordDefinition<T> {
  if (
    !(options.schema instanceof z.ZodObject) ||
    typeof options.key !== "function" ||
    typeof options.owner !== "function"
  )
    throw new JawStackDefinitionError(
      "workflow.record",
      "Atomic records need an object schema and pure key/owner functions.",
    );
  let name: string;
  try {
    name = collectionName(options.name);
  } catch {
    throw new JawStackDefinitionError(
      "workflow.record",
      "Invalid or reserved atomic record collection.",
    );
  }
  const schema = options.schema.strict();
  const key = options.key,
    owner = options.owner;
  const parse = (input: unknown) => {
    const value = jsonCopy(input, workflowCommitLimits.auxiliaryBytes);
    let parsed: unknown;
    try {
      parsed = schema.parse(value);
    } catch {
      reject("Atomic record schema validation failed.");
    }
    const normalized = jsonCopy(parsed, workflowCommitLimits.auxiliaryBytes);
    if (
      !plainObject(normalized) ||
      ["PK", "SK", "itemKind", "tenantId"].some((field) => field in normalized)
    )
      reject("Atomic records cannot supply storage or tenant metadata.");
    return freeze(normalized);
  };
  const definition = Object.freeze({
    name,
    create(value: T): AtomicRecordCreate {
      const contribution = Object.freeze({});
      creates.set(contribution, { definition, value: parse(value) });
      return contribution as AtomicRecordCreate;
    },
  });
  definitions.set(definition, {
    name,
    parse,
    key: (value) => key(value as WorkflowReadonly<T>),
    owner: (value) => owner(value as WorkflowReadonly<T>),
  });
  return definition as AtomicRecordDefinition<T>;
}

export function registerRecords(records: readonly AtomicRecordDefinition[]): ReadonlySet<object> {
  const registry = new Set<object>(),
    names = new Set<string>();
  for (const record of records) {
    const definition = definitions.get(record);
    if (!definition || names.has(definition.name))
      throw new JawStackDefinitionError(
        "workflow.record",
        "Invalid or duplicate atomic record registration.",
      );
    registry.add(record);
    names.add(definition.name);
  }
  return registry;
}

export function resolveRecord(
  create: AtomicRecordCreate,
  registry: ReadonlySet<object>,
  root: AtomicRecordOwner,
) {
  const captured = creates.get(create);
  if (!captured || !registry.has(captured.definition))
    reject("Unregistered or forged atomic record contribution.");
  const definition = definitions.get(captured.definition)!;
  const value = definition.parse(captured.value);
  if (!isDeepStrictEqual(value, captured.value))
    reject("Atomic record schema is not stable under revalidation.");
  const key = utf8(synchronous(definition.key(value)), workflowCommitLimits.logicalKeyBytes);
  const owner = jsonCopy(synchronous(definition.owner(value)));
  if (
    !plainObject(owner) ||
    Object.keys(owner).length !== 2 ||
    component(owner.resourceType) !== root.resourceType ||
    component(owner.resourceId) !== root.resourceId
  )
    reject("Atomic record owner must match the command resource.");
  return { collection: definition.name, logicalKey: key, owner, value };
}

// Flat Dynamo records retain their business schema; ownership is derived, not stored twice.
export function readRecord(
  registry: ReadonlySet<object>,
  collection: string,
  logicalKey: string,
  input: unknown,
) {
  const registered = [...registry].find((record) => definitions.get(record)?.name === collection);
  if (!registered) reject("Unregistered atomic record collection.");
  const definition = definitions.get(registered)!;
  const value = definition.parse(input);
  const owner = synchronous(definition.owner(value));
  const resolved = resolveRecord(
    (registered as AtomicRecordDefinition).create(value),
    registry,
    owner,
  );
  if (resolved.logicalKey !== logicalKey) reject("Atomic record key differs from its value.");
  return { collection, owner: resolved.owner, value: resolved.value };
}
