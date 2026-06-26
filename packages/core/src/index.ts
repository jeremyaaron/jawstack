import { z } from "zod";

export const packageName = "@jawstack/core";

const NAME_PATTERN = /^[a-z][A-Za-z0-9]*$/;
const EVENT_TYPE_PATTERN = /^[a-z][A-Za-z0-9]*(\.[a-z][A-Za-z0-9]*)+$/;

export class JawStackDefinitionError extends Error {
  readonly code: string;
  readonly path: string | undefined;

  constructor(code: string, message: string, path?: string) {
    super(path ? `${message} (${path})` : message);
    this.name = "JawStackDefinitionError";
    this.code = code;
    this.path = path;
  }
}

export type FieldKind = "string" | "text" | "enum" | "boolean" | "datetime";

export type BaseFieldDefinition<TKind extends FieldKind, TValue> = Readonly<{
  kind: TKind;
  required: boolean;
  label?: string;
  description?: string;
  defaultValue?: TValue;
}>;

export type StringFieldDefinition = BaseFieldDefinition<"string", string>;
export type TextFieldDefinition = BaseFieldDefinition<"text", string>;
export type BooleanFieldDefinition = BaseFieldDefinition<"boolean", boolean>;
export type DateTimeFieldDefinition = BaseFieldDefinition<"datetime", string>;

export type EnumFieldDefinition<TValues extends readonly string[] = readonly string[]> = Readonly<
  BaseFieldDefinition<"enum", TValues[number]> & {
    values: readonly TValues[number][];
  }
>;

export type FieldDefinition =
  | StringFieldDefinition
  | TextFieldDefinition
  | EnumFieldDefinition
  | BooleanFieldDefinition
  | DateTimeFieldDefinition;

export type FieldOptions<TValue> = Readonly<{
  required?: boolean;
  label?: string;
  description?: string;
  defaultValue?: TValue;
}>;

export type EnumFieldOptions<TValues extends readonly string[]> = FieldOptions<TValues[number]> &
  Readonly<{
    values: TValues;
  }>;

export type StateFields = Record<string, FieldDefinition>;

export type StateDefinition<TFields extends StateFields = StateFields> = Readonly<{
  kind: "jawstack.state";
  fields: Readonly<TFields>;
}>;

export type EventDeclaration = Readonly<{
  eventType: string;
  schemaVersion: number;
}>;

export type CommandDefinition<TInput = unknown, TResponse = unknown> = Readonly<{
  kind: "jawstack.command";
  title: string;
  input: z.ZodType<TInput>;
  roles: readonly string[];
  emits: readonly EventDeclaration[];
  create: boolean;
  decide: unknown;
  response?: TResponse;
}>;

export type DefineCommandInput<TInput = unknown, TResponse = unknown> = Readonly<{
  title: string;
  input: z.ZodType<TInput>;
  roles: readonly string[];
  emits: readonly EventDeclaration[];
  create?: boolean;
  decide: CommandDecide<unknown, TInput, TResponse>;
  response?: TResponse;
}>;

export type ListViewDefinition = Readonly<{
  kind: "jawstack.view.list";
  title?: string;
  columns: readonly string[];
}>;

export type DetailViewDefinition = Readonly<{
  kind: "jawstack.view.detail";
  titleField: string;
  sections: readonly string[];
}>;

export type ResourceViews = Readonly<{
  list?: ListViewDefinition;
  detail?: DetailViewDefinition;
}>;

export type WorkerDefinition = Readonly<{
  name: string;
  eventTypes: readonly string[];
  maxConcurrency?: number;
  handler?: unknown;
}>;

export type ScheduleDefinition = Readonly<{
  name: string;
  expression: string;
  targetHandler?: string;
}>;

export type ResourceDefinition<
  TState extends StateDefinition = StateDefinition,
  TCommands extends Record<string, CommandDefinition> = Record<string, CommandDefinition>,
> = Readonly<{
  kind: "jawstack.resource";
  name: string;
  title: string;
  state: TState;
  commands: Readonly<TCommands>;
  views: ResourceViews;
  workers: readonly WorkerDefinition[];
  schedules: readonly ScheduleDefinition[];
}>;

export type DefineResourceInput<
  TState extends StateDefinition,
  TCommands extends Record<string, CommandDefinition>,
> = Readonly<{
  name: string;
  title: string;
  state: TState;
  commands: TCommands;
  views?: ResourceViews;
  workers?: readonly WorkerDefinition[];
  schedules?: readonly ScheduleDefinition[];
}>;

export type AuthMode = "dev" | "test" | "external";

export type AuthContext = Readonly<{
  subject: string;
  displayName?: string;
  tenantId?: string;
  roles: readonly string[];
  claims: Record<string, unknown>;
  mode: AuthMode;
}>;

export type Actor = Readonly<{
  subject: string;
  displayName?: string;
}>;

export type JawStackEvent<TPayload = unknown> = Readonly<{
  envelopeVersion: 1;
  eventId: string;
  eventType: string;
  schemaVersion: number;
  source: string;
  resourceType: string;
  resourceId: string;
  tenantId?: string;
  actor?: Actor;
  correlationId: string;
  causationId?: string;
  occurredAt: string;
  payload: TPayload;
}>;

export type CommandRequest<TInput = unknown> = Readonly<{
  requestId?: string;
  correlationId?: string;
  resourceType: string;
  resourceId?: string;
  commandName: string;
  input: TInput;
  idempotencyKey?: string;
  requestContext: unknown;
}>;

export type IdGenerator = Readonly<{
  eventId(): string;
  activityId(): string;
  requestId(): string;
  correlationId(): string;
  resourceId(resourceType: string): string;
}>;

export type ResourceState<TState = unknown> = Readonly<{
  resourceType: string;
  resourceId: string;
  version: number;
  state: TState;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  updatedBy: string;
  tenantId?: string;
}>;

export type CommandContext<TState = unknown, TInput = unknown> = Readonly<{
  auth: AuthContext;
  input: TInput;
  previous: ResourceState<TState> | undefined;
  resourceId: string;
  requestId: string;
  correlationId: string;
  now: Date;
  ids: IdGenerator;
}>;

export type ActivityDraft = Readonly<{
  activityType: string;
  title: string;
  summary?: string;
  data?: Record<string, unknown>;
}>;

export type ActivityRecord = Readonly<{
  activityId: string;
  resourceType: string;
  resourceId: string;
  activityType: string;
  title: string;
  summary?: string;
  data?: Record<string, unknown>;
  actor?: Actor;
  tenantId?: string;
  correlationId: string;
  causationId?: string;
  occurredAt: string;
}>;

export type EventDraft<TPayload = unknown> = Readonly<{
  eventType: string;
  schemaVersion: number;
  payload: TPayload;
}>;

export type ProjectionWrite = Readonly<{
  projectionName: string;
  itemId: string;
  sort: string;
  data: Record<string, unknown>;
  delete?: boolean;
}>;

export type ProjectionRecord = ProjectionWrite;

export type CommandDecision<TState = unknown, TResponse = unknown> = Readonly<{
  nextState: TState;
  activity: readonly ActivityDraft[];
  events: readonly EventDraft[];
  projections?: readonly ProjectionWrite[];
  response: TResponse;
}>;

export type IdempotencyRecord<TResponse = unknown> = Readonly<{
  key: string;
  fingerprint: string;
  response: ApiSuccess<TResponse>;
}>;

export type IdempotencyCommit<TResponse = unknown> = IdempotencyRecord<TResponse>;

export type CommandDecide<TState = unknown, TInput = unknown, TResponse = unknown> = (
  context: CommandContext<TState, TInput>,
) => CommandDecision<TState, TResponse> | Promise<CommandDecision<TState, TResponse>>;

export type CommandCommitInput<TState = unknown, TResponse = unknown> = Readonly<{
  resource: Readonly<{
    resourceType: string;
    resourceId: string;
    expectedVersion?: number;
    next: ResourceState<TState>;
    create: boolean;
  }>;
  activity: readonly ActivityRecord[];
  outbox: readonly JawStackEvent[];
  projections: readonly ProjectionWrite[];
  response: TResponse;
  idempotency?: IdempotencyCommit<TResponse>;
}>;

export type ResourceRepository = Readonly<{
  getState(resourceType: string, resourceId: string): Promise<ResourceState | undefined>;
  getIdempotency?(key: string): Promise<IdempotencyRecord | undefined>;
}>;

export type CommandUnitOfWork = Readonly<{
  commit<TState = unknown, TResponse = unknown>(
    input: CommandCommitInput<TState, TResponse>,
  ): Promise<void>;
}>;

export type AuthProvider = Readonly<{
  resolve(requestContext: unknown): Promise<AuthContext> | AuthContext;
}>;

export type ApiSuccess<T> = Readonly<{
  ok: true;
  data: T;
  meta: Readonly<{
    requestId: string;
    correlationId: string;
  }>;
}>;

export type RuntimeErrorCode =
  | "command.validation"
  | "command.rejected"
  | "auth.missing"
  | "auth.forbidden"
  | "resource.not_found"
  | "resource.conflict"
  | "resource.invalid_state"
  | "idempotency.conflict"
  | "runtime.internal"
  | "runtime.unavailable";

export type ApiError = Readonly<{
  ok: false;
  error: Readonly<{
    code: RuntimeErrorCode;
    message: string;
    details?: unknown;
  }>;
  meta: Readonly<{
    requestId: string;
    correlationId: string;
  }>;
}>;

export type CommandExecutionResult<TResponse = unknown> = ApiSuccess<TResponse> | ApiError;

export class JawStackRuntimeError extends Error {
  readonly code: RuntimeErrorCode;
  readonly details: unknown;

  constructor(code: RuntimeErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "JawStackRuntimeError";
    this.code = code;
    this.details = details;
  }
}

export type ResourceRegistry = Readonly<{
  resources: readonly ResourceDefinition[];
  getResource(resourceType: string): ResourceDefinition | undefined;
}>;

export type CommandExecutorOptions = Readonly<{
  registry: ResourceRegistry | readonly ResourceDefinition[];
  repository: ResourceRepository;
  unitOfWork: CommandUnitOfWork;
  authProvider: AuthProvider;
  ids?: Partial<IdGenerator>;
  clock?: () => Date;
  source?: string;
}>;

export class InMemoryStore {
  readonly resources = new Map<string, ResourceState>();
  readonly activity: ActivityRecord[] = [];
  readonly outbox: JawStackEvent[] = [];
  readonly projections = new Map<string, ProjectionRecord>();
  readonly idempotency = new Map<string, IdempotencyRecord>();

  clear(): void {
    this.resources.clear();
    this.activity.splice(0);
    this.outbox.splice(0);
    this.projections.clear();
    this.idempotency.clear();
  }
}

export class InMemoryRepository implements ResourceRepository {
  constructor(private readonly store: InMemoryStore = new InMemoryStore()) {}

  getStore(): InMemoryStore {
    return this.store;
  }

  async getState<TState = unknown>(
    resourceType: string,
    resourceId: string,
  ): Promise<ResourceState<TState> | undefined> {
    const state = this.store.resources.get(resourceKey(resourceType, resourceId));
    return state === undefined ? undefined : cloneValue(state as ResourceState<TState>);
  }

  async getIdempotency(key: string): Promise<IdempotencyRecord | undefined> {
    const record = this.store.idempotency.get(key);
    return record === undefined ? undefined : cloneValue(record);
  }

  async listProjection(projectionName: string): Promise<ProjectionRecord[]> {
    return [...this.store.projections.values()]
      .filter((record) => record.projectionName === projectionName)
      .sort((left, right) => left.sort.localeCompare(right.sort))
      .map((record) => cloneValue(record));
  }

  async getActivity(resourceType: string, resourceId: string): Promise<ActivityRecord[]> {
    return this.store.activity
      .filter((record) => record.resourceType === resourceType && record.resourceId === resourceId)
      .map((record) => cloneValue(record));
  }

  async getOutbox(): Promise<JawStackEvent[]> {
    return this.store.outbox.map((record) => cloneValue(record));
  }
}

export class InMemoryUnitOfWork implements CommandUnitOfWork {
  constructor(private readonly store: InMemoryStore = new InMemoryStore()) {}

  getStore(): InMemoryStore {
    return this.store;
  }

  async commit<TState = unknown, TResponse = unknown>(
    input: CommandCommitInput<TState, TResponse>,
  ): Promise<void> {
    const key = resourceKey(input.resource.resourceType, input.resource.resourceId);
    const current = this.store.resources.get(key);

    if (input.idempotency !== undefined) {
      const existing = this.store.idempotency.get(input.idempotency.key);

      if (existing !== undefined) {
        if (existing.fingerprint !== input.idempotency.fingerprint) {
          throw new JawStackRuntimeError(
            "idempotency.conflict",
            "Idempotency key was already used for a different command payload.",
          );
        }

        return;
      }
    }

    if (input.resource.create && current !== undefined) {
      throw new JawStackRuntimeError(
        "resource.conflict",
        `Resource "${input.resource.resourceType}" with ID "${input.resource.resourceId}" already exists.`,
      );
    }

    if (!input.resource.create) {
      if (current === undefined) {
        throw new JawStackRuntimeError(
          "resource.not_found",
          `Resource "${input.resource.resourceType}" with ID "${input.resource.resourceId}" was not found.`,
        );
      }

      if (input.resource.expectedVersion !== current.version) {
        throw new JawStackRuntimeError(
          "resource.conflict",
          `Resource "${input.resource.resourceType}" with ID "${input.resource.resourceId}" changed before commit.`,
          {
            expectedVersion: input.resource.expectedVersion,
            actualVersion: current.version,
          },
        );
      }
    }

    this.store.resources.set(key, cloneValue(input.resource.next));
    this.store.activity.push(...input.activity.map((record) => cloneValue(record)));
    this.store.outbox.push(...input.outbox.map((record) => cloneValue(record)));

    for (const projection of input.projections) {
      this.deleteProjectionItem(projection.projectionName, projection.itemId);

      if (projection.delete !== true) {
        this.store.projections.set(projectionKey(projection), cloneValue(projection));
      }
    }

    if (input.idempotency !== undefined) {
      this.store.idempotency.set(input.idempotency.key, cloneValue(input.idempotency));
    }
  }

  private deleteProjectionItem(projectionName: string, itemId: string): void {
    const prefix = projectionItemPrefix(projectionName, itemId);

    for (const key of this.store.projections.keys()) {
      if (key.startsWith(prefix)) {
        this.store.projections.delete(key);
      }
    }
  }
}

export function createInMemoryPersistence(store = new InMemoryStore()): Readonly<{
  store: InMemoryStore;
  repository: InMemoryRepository;
  unitOfWork: InMemoryUnitOfWork;
}> {
  return {
    store,
    repository: new InMemoryRepository(store),
    unitOfWork: new InMemoryUnitOfWork(store),
  };
}

function definitionError(code: string, message: string, path?: string): never {
  throw new JawStackDefinitionError(code, message, path);
}

function assertPlainObject(value: unknown, code: string, path: string): asserts value is object {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    definitionError(code, "Expected an object.", path);
  }
}

function assertNonEmptyString(value: unknown, code: string, path: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    definitionError(code, "Expected a non-empty string.", path);
  }
}

function assertName(value: unknown, code: string, path: string): asserts value is string {
  assertNonEmptyString(value, code, path);

  if (!NAME_PATTERN.test(value)) {
    definitionError(code, "Expected a lower-camel-case identifier.", path);
  }
}

function assertEventType(value: unknown, path: string): asserts value is string {
  assertNonEmptyString(value, "event.type.invalid", path);

  if (!EVENT_TYPE_PATTERN.test(value)) {
    definitionError(
      "event.type.invalid",
      "Expected an event type such as workRequest.created.",
      path,
    );
  }
}

function assertPositiveInteger(
  value: unknown,
  code: string,
  path: string,
): asserts value is number {
  if (!Number.isInteger(value) || typeof value !== "number" || value <= 0) {
    definitionError(code, "Expected a positive integer.", path);
  }
}

function assertNonEmptyStringArray(
  value: unknown,
  code: string,
  path: string,
): asserts value is readonly string[] {
  if (!Array.isArray(value) || value.length === 0) {
    definitionError(code, "Expected a non-empty string array.", path);
  }

  value.forEach((item, index) => {
    assertNonEmptyString(item, code, `${path}[${index}]`);
  });
}

function assertNoDuplicateStrings(values: readonly string[], code: string, path: string): void {
  const seen = new Set<string>();

  values.forEach((value, index) => {
    if (seen.has(value)) {
      definitionError(code, `Duplicate value "${value}".`, `${path}[${index}]`);
    }

    seen.add(value);
  });
}

function isPlainFreezableObject(value: object): boolean {
  if (Array.isArray(value)) {
    return true;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }

  if (!isPlainFreezableObject(value)) {
    return value;
  }

  Object.freeze(value);

  for (const nested of Object.values(value)) {
    deepFreeze(nested);
  }

  return value;
}

function cloneValue<T>(value: T): T {
  return structuredClone(value);
}

function resourceKey(resourceType: string, resourceId: string): string {
  return `${resourceType}\u0000${resourceId}`;
}

function projectionItemPrefix(projectionName: string, itemId: string): string {
  return `${projectionName}\u0000${itemId}\u0000`;
}

function projectionKey(projection: ProjectionWrite): string {
  return `${projectionItemPrefix(projection.projectionName, projection.itemId)}${projection.sort}`;
}

function normalizeForStableJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeForStableJson(item));
  }

  if (!isPlainFreezableObjectForStableJson(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([entryKey, entryValue]) => [entryKey, normalizeForStableJson(entryValue)]),
  );
}

function isPlainFreezableObjectForStableJson(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(normalizeForStableJson(value));
}

function createIdempotencyFingerprint(input: {
  resourceType: string;
  resourceId: string | undefined;
  commandName: string;
  input: unknown;
}): string {
  return stableStringify(input);
}

function createBaseField<TKind extends FieldKind, TValue>(
  kind: TKind,
  options: FieldOptions<TValue> = {},
): BaseFieldDefinition<TKind, TValue> {
  if (options.label !== undefined) {
    assertNonEmptyString(options.label, "field.label.invalid", "label");
  }

  if (options.description !== undefined) {
    assertNonEmptyString(options.description, "field.description.invalid", "description");
  }

  const fieldDefinition = {
    kind,
    required: options.required ?? false,
    ...(options.label === undefined ? {} : { label: options.label }),
    ...(options.description === undefined ? {} : { description: options.description }),
    ...(options.defaultValue === undefined ? {} : { defaultValue: options.defaultValue }),
  };

  return deepFreeze(fieldDefinition);
}

export const field = {
  string(options: FieldOptions<string> = {}): StringFieldDefinition {
    return createBaseField("string", options);
  },

  text(options: FieldOptions<string> = {}): TextFieldDefinition {
    return createBaseField("text", options);
  },

  enum<const TValues extends readonly string[]>(
    options: EnumFieldOptions<TValues>,
  ): EnumFieldDefinition<TValues> {
    assertNonEmptyStringArray(options.values, "field.enum.values.invalid", "values");
    assertNoDuplicateStrings(options.values, "field.enum.values.duplicate", "values");

    if (
      options.defaultValue !== undefined &&
      !options.values.includes(options.defaultValue as TValues[number])
    ) {
      definitionError(
        "field.enum.default.invalid",
        "Expected enum defaultValue to be one of the declared values.",
        "defaultValue",
      );
    }

    const enumDefinition = {
      ...createBaseField("enum", options),
      values: [...options.values],
    };

    return deepFreeze(enumDefinition);
  },

  boolean(options: FieldOptions<boolean> = {}): BooleanFieldDefinition {
    return createBaseField("boolean", options);
  },

  datetime(options: FieldOptions<string> = {}): DateTimeFieldDefinition {
    return createBaseField("datetime", options);
  },
} as const;

export function defineState<const TFields extends StateFields>(
  fields: TFields,
): StateDefinition<TFields> {
  assertPlainObject(fields, "state.fields.invalid", "fields");

  const entries = Object.entries(fields);

  if (entries.length === 0) {
    definitionError("state.fields.empty", "Expected at least one state field.", "fields");
  }

  for (const [name, definition] of entries) {
    assertName(name, "field.name.invalid", `fields.${name}`);
    assertPlainObject(definition, "field.definition.invalid", `fields.${name}`);
    assertNonEmptyString(definition.kind, "field.kind.invalid", `fields.${name}.kind`);
  }

  return deepFreeze({
    kind: "jawstack.state",
    fields: { ...fields },
  });
}

export function defineCommand<TInput = unknown, TResponse = unknown>(
  input: DefineCommandInput<TInput, TResponse>,
): CommandDefinition<TInput, TResponse> {
  assertPlainObject(input, "command.definition.invalid", "command");
  assertNonEmptyString(input.title, "command.title.invalid", "command.title");

  if (!Array.isArray(input.roles) || input.roles.length === 0) {
    definitionError("command.roles.empty", "Expected at least one command role.", "command.roles");
  }

  input.roles.forEach((role, index) => {
    assertName(role, "command.role.invalid", `command.roles[${index}]`);
  });
  assertNoDuplicateStrings(input.roles, "command.roles.duplicate", "command.roles");

  if (!Array.isArray(input.emits) || input.emits.length === 0) {
    definitionError("command.emits.empty", "Expected at least one emitted event.", "command.emits");
  }

  input.emits.forEach((event, index) => {
    assertPlainObject(event, "event.definition.invalid", `command.emits[${index}]`);

    const eventDeclaration = event as Partial<EventDeclaration>;
    assertEventType(eventDeclaration.eventType, `command.emits[${index}].eventType`);
    assertPositiveInteger(
      eventDeclaration.schemaVersion,
      "event.schema-version.invalid",
      `command.emits[${index}].schemaVersion`,
    );
  });

  if (typeof input.decide !== "function") {
    definitionError(
      "command.handler.missing",
      "Expected command decide to be a function.",
      "decide",
    );
  }

  const baseCommandDefinition = {
    kind: "jawstack.command",
    title: input.title,
    input: input.input,
    roles: [...input.roles],
    emits: input.emits.map((event) => ({ ...event })),
    create: input.create ?? false,
    decide: input.decide,
  } satisfies CommandDefinition<TInput, TResponse>;

  const commandDefinition =
    input.response === undefined
      ? baseCommandDefinition
      : ({
          ...baseCommandDefinition,
          response: input.response,
        } satisfies CommandDefinition<TInput, TResponse>);

  return deepFreeze(commandDefinition);
}

export function defineListView(input: {
  readonly title?: string;
  readonly columns: readonly string[];
}): ListViewDefinition {
  assertPlainObject(input, "view.list.invalid", "view");

  if (input.title !== undefined) {
    assertNonEmptyString(input.title, "view.list.title.invalid", "view.title");
  }

  assertNonEmptyStringArray(input.columns, "view.list.columns.invalid", "view.columns");
  assertNoDuplicateStrings(input.columns, "view.list.columns.duplicate", "view.columns");

  return deepFreeze({
    kind: "jawstack.view.list",
    ...(input.title === undefined ? {} : { title: input.title }),
    columns: [...input.columns],
  });
}

export function defineDetailView(input: {
  readonly titleField: string;
  readonly sections: readonly string[];
}): DetailViewDefinition {
  assertPlainObject(input, "view.detail.invalid", "view");
  assertName(input.titleField, "view.detail.title-field.invalid", "view.titleField");
  assertNonEmptyStringArray(input.sections, "view.detail.sections.invalid", "view.sections");
  assertNoDuplicateStrings(input.sections, "view.detail.sections.duplicate", "view.sections");

  return deepFreeze({
    kind: "jawstack.view.detail",
    titleField: input.titleField,
    sections: [...input.sections],
  });
}

export function defineWorker(input: WorkerDefinition): WorkerDefinition {
  assertPlainObject(input, "worker.definition.invalid", "worker");
  assertName(input.name, "worker.name.invalid", "worker.name");
  assertNonEmptyStringArray(input.eventTypes, "worker.event-types.invalid", "worker.eventTypes");

  input.eventTypes.forEach((eventType, index) => {
    assertEventType(eventType, `worker.eventTypes[${index}]`);
  });

  if (input.maxConcurrency !== undefined) {
    assertPositiveInteger(
      input.maxConcurrency,
      "worker.max-concurrency.invalid",
      "worker.maxConcurrency",
    );
  }

  return deepFreeze({
    name: input.name,
    eventTypes: [...input.eventTypes],
    ...(input.maxConcurrency === undefined ? {} : { maxConcurrency: input.maxConcurrency }),
    ...(input.handler === undefined ? {} : { handler: input.handler }),
  });
}

export function defineSchedule(input: ScheduleDefinition): ScheduleDefinition {
  assertPlainObject(input, "schedule.definition.invalid", "schedule");
  assertName(input.name, "schedule.name.invalid", "schedule.name");
  assertNonEmptyString(input.expression, "schedule.expression.invalid", "schedule.expression");

  if (input.targetHandler !== undefined) {
    assertNonEmptyString(
      input.targetHandler,
      "schedule.target-handler.invalid",
      "schedule.targetHandler",
    );
  }

  return deepFreeze({
    name: input.name,
    expression: input.expression,
    ...(input.targetHandler === undefined ? {} : { targetHandler: input.targetHandler }),
  });
}

function validateViewFields(state: StateDefinition, views: ResourceViews): void {
  const fieldNames = new Set(Object.keys(state.fields));

  if (views.list !== undefined) {
    views.list.columns.forEach((column, index) => {
      if (!fieldNames.has(column)) {
        definitionError(
          "view.list.column.unknown",
          `Unknown list column "${column}".`,
          `views.list.columns[${index}]`,
        );
      }
    });
  }

  if (views.detail !== undefined && !fieldNames.has(views.detail.titleField)) {
    definitionError(
      "view.detail.title-field.unknown",
      `Unknown title field "${views.detail.titleField}".`,
      "views.detail.titleField",
    );
  }
}

export function defineResource<
  const TState extends StateDefinition,
  const TCommands extends Record<string, CommandDefinition>,
>(input: DefineResourceInput<TState, TCommands>): ResourceDefinition<TState, TCommands> {
  assertPlainObject(input, "resource.definition.invalid", "resource");
  assertName(input.name, "resource.name.invalid", "resource.name");
  assertNonEmptyString(input.title, "resource.title.invalid", "resource.title");
  assertPlainObject(input.state, "resource.state.invalid", "resource.state");
  assertPlainObject(input.commands, "resource.commands.invalid", "resource.commands");

  const commandEntries = Object.entries(input.commands);

  if (commandEntries.length === 0) {
    definitionError(
      "resource.commands.empty",
      "Expected at least one resource command.",
      "resource.commands",
    );
  }

  for (const [name, command] of commandEntries) {
    assertName(name, "command.name.invalid", `commands.${name}`);
    assertPlainObject(command, "command.definition.invalid", `commands.${name}`);
  }

  const views = input.views ?? {};
  validateViewFields(input.state, views);

  const workers = (input.workers ?? []).map((worker) => defineWorker(worker));
  const schedules = (input.schedules ?? []).map((schedule) => defineSchedule(schedule));

  const resourceDefinition = {
    kind: "jawstack.resource",
    name: input.name,
    title: input.title,
    state: input.state,
    commands: { ...input.commands },
    views,
    workers,
    schedules,
  } satisfies ResourceDefinition<TState, TCommands>;

  return deepFreeze(resourceDefinition);
}

export function createResourceRegistry(resources: readonly ResourceDefinition[]): ResourceRegistry {
  if (!Array.isArray(resources) || resources.length === 0) {
    definitionError("registry.resources.empty", "Expected at least one resource.", "resources");
  }

  const byName = new Map<string, ResourceDefinition>();

  for (const resource of resources) {
    if (byName.has(resource.name)) {
      definitionError(
        "resource.name.duplicate",
        `Duplicate resource name "${resource.name}".`,
        "resources",
      );
    }

    byName.set(resource.name, resource);
  }

  return deepFreeze({
    resources: [...resources],
    getResource(resourceType: string): ResourceDefinition | undefined {
      return byName.get(resourceType);
    },
  });
}

function isResourceArray(
  registry: ResourceRegistry | readonly ResourceDefinition[],
): registry is readonly ResourceDefinition[] {
  return Array.isArray(registry);
}

function normalizeRegistry(
  registry: ResourceRegistry | readonly ResourceDefinition[],
): ResourceRegistry {
  return isResourceArray(registry) ? createResourceRegistry(registry) : registry;
}

function randomId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function createIdGenerator(overrides: Partial<IdGenerator> = {}): IdGenerator {
  return {
    eventId: overrides.eventId ?? (() => randomId("evt")),
    activityId: overrides.activityId ?? (() => randomId("act")),
    requestId: overrides.requestId ?? (() => randomId("req")),
    correlationId: overrides.correlationId ?? (() => randomId("corr")),
    resourceId: overrides.resourceId ?? ((resourceType) => `${resourceType}_${randomId("res")}`),
  };
}

function actorFromAuth(auth: AuthContext): Actor {
  return {
    subject: auth.subject,
    ...(auth.displayName === undefined ? {} : { displayName: auth.displayName }),
  };
}

function apiSuccess<T>(data: T, requestId: string, correlationId: string): ApiSuccess<T> {
  return {
    ok: true,
    data,
    meta: {
      requestId,
      correlationId,
    },
  };
}

function apiError(
  code: RuntimeErrorCode,
  message: string,
  requestId: string,
  correlationId: string,
  details?: unknown,
): ApiError {
  return {
    ok: false,
    error: {
      code,
      message,
      ...(details === undefined ? {} : { details }),
    },
    meta: {
      requestId,
      correlationId,
    },
  };
}

function runtimeErrorToApiError(
  error: unknown,
  requestId: string,
  correlationId: string,
): ApiError {
  if (error instanceof JawStackRuntimeError) {
    return apiError(error.code, error.message, requestId, correlationId, error.details);
  }

  return apiError(
    "runtime.internal",
    "An internal runtime error occurred.",
    requestId,
    correlationId,
  );
}

function assertAuthContext(auth: AuthContext): void {
  if (typeof auth.subject !== "string" || auth.subject.trim().length === 0) {
    throw new JawStackRuntimeError("auth.missing", "Auth context is missing a subject.");
  }

  if (!Array.isArray(auth.roles)) {
    throw new JawStackRuntimeError("auth.missing", "Auth context roles are invalid.");
  }
}

function findCommand(
  resource: ResourceDefinition,
  commandName: string,
): CommandDefinition | undefined {
  return resource.commands[commandName];
}

function getCommandDecide(command: CommandDefinition): CommandDecide {
  if (typeof command.decide !== "function") {
    throw new JawStackRuntimeError("runtime.internal", "Command decide handler is not executable.");
  }

  return command.decide as CommandDecide;
}

function assertDecision(decision: CommandDecision, command: CommandDefinition): void {
  if (typeof decision !== "object" || decision === null) {
    throw new JawStackRuntimeError("command.rejected", "Command returned an invalid decision.");
  }

  if (!Array.isArray(decision.activity)) {
    throw new JawStackRuntimeError(
      "command.rejected",
      "Command decision activity must be an array.",
    );
  }

  if (!Array.isArray(decision.events) || decision.events.length === 0) {
    throw new JawStackRuntimeError(
      "command.rejected",
      "State-changing commands must emit at least one event.",
    );
  }

  const declaredEvents = new Set(
    command.emits.map((event) => `${event.eventType}@${event.schemaVersion}`),
  );

  for (const event of decision.events) {
    const eventKey = `${event.eventType}@${event.schemaVersion}`;

    if (!declaredEvents.has(eventKey)) {
      throw new JawStackRuntimeError(
        "command.rejected",
        `Command emitted undeclared event "${event.eventType}" schema version ${event.schemaVersion}.`,
      );
    }
  }
}

function buildActivityRecords(input: {
  drafts: readonly ActivityDraft[];
  resourceType: string;
  resourceId: string;
  auth: AuthContext;
  nowIso: string;
  correlationId: string;
  causationId: string;
  ids: IdGenerator;
}): ActivityRecord[] {
  return input.drafts.map((draft) => ({
    activityId: input.ids.activityId(),
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    activityType: draft.activityType,
    title: draft.title,
    ...(draft.summary === undefined ? {} : { summary: draft.summary }),
    ...(draft.data === undefined ? {} : { data: draft.data }),
    actor: actorFromAuth(input.auth),
    ...(input.auth.tenantId === undefined ? {} : { tenantId: input.auth.tenantId }),
    correlationId: input.correlationId,
    causationId: input.causationId,
    occurredAt: input.nowIso,
  }));
}

function buildEvents(input: {
  drafts: readonly EventDraft[];
  source: string;
  resourceType: string;
  resourceId: string;
  auth: AuthContext;
  nowIso: string;
  correlationId: string;
  causationId: string;
  ids: IdGenerator;
}): JawStackEvent[] {
  return input.drafts.map((draft) => ({
    envelopeVersion: 1,
    eventId: input.ids.eventId(),
    eventType: draft.eventType,
    schemaVersion: draft.schemaVersion,
    source: input.source,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    ...(input.auth.tenantId === undefined ? {} : { tenantId: input.auth.tenantId }),
    actor: actorFromAuth(input.auth),
    correlationId: input.correlationId,
    causationId: input.causationId,
    occurredAt: input.nowIso,
    payload: draft.payload,
  }));
}

function buildNextResourceState<TState>(input: {
  resourceType: string;
  resourceId: string;
  previous: ResourceState<TState> | undefined;
  nextState: TState;
  auth: AuthContext;
  nowIso: string;
}): ResourceState<TState> {
  return {
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    version: input.previous === undefined ? 1 : input.previous.version + 1,
    state: input.nextState,
    createdAt: input.previous?.createdAt ?? input.nowIso,
    updatedAt: input.nowIso,
    createdBy: input.previous?.createdBy ?? input.auth.subject,
    updatedBy: input.auth.subject,
    ...(input.auth.tenantId === undefined ? {} : { tenantId: input.auth.tenantId }),
  };
}

export const workRequestStatusValues = ["open", "inReview", "blocked", "closed"] as const;

export type WorkRequestStatus = (typeof workRequestStatusValues)[number];

export type WorkRequestComment = Readonly<{
  commentId: string;
  body: string;
  author: Actor;
  createdAt: string;
}>;

export type WorkRequestState = Readonly<{
  title: string;
  description?: string;
  status: WorkRequestStatus;
  assigneeId?: string;
  updatedAt: string;
  comments: readonly WorkRequestComment[];
}>;

export const createWorkRequestInput = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
});

export const assignWorkRequestInput = z.object({
  assigneeId: z.string().min(1),
});

export const changeWorkRequestStatusInput = z.object({
  status: z.enum(workRequestStatusValues),
});

export const commentWorkRequestInput = z.object({
  body: z.string().min(1),
});

export const closeWorkRequestInput = z.object({
  reason: z.string().optional(),
});

export type CreateWorkRequestInput = z.infer<typeof createWorkRequestInput>;
export type AssignWorkRequestInput = z.infer<typeof assignWorkRequestInput>;
export type ChangeWorkRequestStatusInput = z.infer<typeof changeWorkRequestStatusInput>;
export type CommentWorkRequestInput = z.infer<typeof commentWorkRequestInput>;
export type CloseWorkRequestInput = z.infer<typeof closeWorkRequestInput>;

export type WorkRequestCommandResponse = Readonly<{
  resourceId: string;
  status: WorkRequestStatus;
}>;

export type CreateWorkRequestResponse = WorkRequestCommandResponse;
export type AssignWorkRequestResponse = WorkRequestCommandResponse &
  Readonly<{
    assigneeId: string;
  }>;
export type ChangeWorkRequestStatusResponse = WorkRequestCommandResponse;
export type CommentWorkRequestResponse = WorkRequestCommandResponse &
  Readonly<{
    commentId: string;
  }>;
export type CloseWorkRequestResponse = WorkRequestCommandResponse;

function getPreviousWorkRequestState(previous: ResourceState | undefined): WorkRequestState {
  if (previous === undefined) {
    throw new JawStackRuntimeError("resource.not_found", "Work request state is missing.");
  }

  return previous.state as WorkRequestState;
}

function workRequestProjectionSort(updatedAt: string, resourceId: string): string {
  const timestamp = Date.parse(updatedAt);
  const safeTimestamp = Number.isFinite(timestamp) ? timestamp : 0;
  const reverseTimestamp = Number.MAX_SAFE_INTEGER - safeTimestamp;
  return `${String(reverseTimestamp).padStart(16, "0")}#${resourceId}`;
}

function workRequestListProjection(resourceId: string, state: WorkRequestState): ProjectionWrite {
  return {
    projectionName: "workRequest.list",
    itemId: resourceId,
    sort: workRequestProjectionSort(state.updatedAt, resourceId),
    data: {
      resourceId,
      title: state.title,
      status: state.status,
      updatedAt: state.updatedAt,
      ...(state.assigneeId === undefined ? {} : { assigneeId: state.assigneeId }),
    },
  };
}

export const createWorkRequest: CommandDecide<
  unknown,
  CreateWorkRequestInput,
  CreateWorkRequestResponse
> = ({ auth, input, resourceId, now }) => {
  const updatedAt = now.toISOString();
  const nextState: WorkRequestState = {
    title: input.title,
    ...(input.description === undefined ? {} : { description: input.description }),
    status: "open",
    updatedAt,
    comments: [],
  };

  return {
    nextState,
    activity: [
      {
        activityType: "created",
        title: "Created work request",
        data: { title: input.title },
      },
    ],
    events: [
      {
        eventType: "workRequest.created",
        schemaVersion: 1,
        payload: {
          title: input.title,
          ...(input.description === undefined ? {} : { description: input.description }),
          actor: actorFromAuth(auth),
        },
      },
    ],
    projections: [workRequestListProjection(resourceId, nextState)],
    response: { resourceId, status: nextState.status },
  };
};

export const assignWorkRequest: CommandDecide<
  unknown,
  AssignWorkRequestInput,
  AssignWorkRequestResponse
> = ({ previous, input, resourceId, now }) => {
  const current = getPreviousWorkRequestState(previous);
  const nextState: WorkRequestState = {
    ...current,
    assigneeId: input.assigneeId,
    updatedAt: now.toISOString(),
    comments: [...current.comments],
  };

  return {
    nextState,
    activity: [
      {
        activityType: "assigned",
        title: "Assigned work request",
        data: { assigneeId: input.assigneeId },
      },
    ],
    events: [
      {
        eventType: "workRequest.assigned",
        schemaVersion: 1,
        payload: { assigneeId: input.assigneeId },
      },
    ],
    projections: [workRequestListProjection(resourceId, nextState)],
    response: { resourceId, status: nextState.status, assigneeId: input.assigneeId },
  };
};

export const changeWorkRequestStatus: CommandDecide<
  unknown,
  ChangeWorkRequestStatusInput,
  ChangeWorkRequestStatusResponse
> = ({ previous, input, resourceId, now }) => {
  const current = getPreviousWorkRequestState(previous);
  const nextState: WorkRequestState = {
    ...current,
    status: input.status,
    updatedAt: now.toISOString(),
    comments: [...current.comments],
  };

  return {
    nextState,
    activity: [
      {
        activityType: "statusChanged",
        title: "Changed work request status",
        data: { previousStatus: current.status, status: input.status },
      },
    ],
    events: [
      {
        eventType: "workRequest.statusChanged",
        schemaVersion: 1,
        payload: { previousStatus: current.status, status: input.status },
      },
    ],
    projections: [workRequestListProjection(resourceId, nextState)],
    response: { resourceId, status: nextState.status },
  };
};

export const commentWorkRequest: CommandDecide<
  unknown,
  CommentWorkRequestInput,
  CommentWorkRequestResponse
> = ({ auth, previous, input, resourceId, requestId, now }) => {
  const current = getPreviousWorkRequestState(previous);
  const comment: WorkRequestComment = {
    commentId: `comment_${requestId}`,
    body: input.body,
    author: actorFromAuth(auth),
    createdAt: now.toISOString(),
  };
  const nextState: WorkRequestState = {
    ...current,
    updatedAt: comment.createdAt,
    comments: [...current.comments, comment],
  };

  return {
    nextState,
    activity: [
      {
        activityType: "commentAdded",
        title: "Added comment",
        data: { commentId: comment.commentId },
      },
    ],
    events: [
      {
        eventType: "workRequest.commentAdded",
        schemaVersion: 1,
        payload: {
          commentId: comment.commentId,
          body: input.body,
        },
      },
    ],
    projections: [workRequestListProjection(resourceId, nextState)],
    response: { resourceId, status: nextState.status, commentId: comment.commentId },
  };
};

export const closeWorkRequest: CommandDecide<
  unknown,
  CloseWorkRequestInput,
  CloseWorkRequestResponse
> = ({ previous, input, resourceId, now }) => {
  const current = getPreviousWorkRequestState(previous);
  const nextState: WorkRequestState = {
    ...current,
    status: "closed",
    updatedAt: now.toISOString(),
    comments: [...current.comments],
  };

  return {
    nextState,
    activity: [
      {
        activityType: "closed",
        title: "Closed work request",
        ...(input.reason === undefined ? {} : { summary: input.reason }),
      },
    ],
    events: [
      {
        eventType: "workRequest.closed",
        schemaVersion: 1,
        payload: {
          ...(input.reason === undefined ? {} : { reason: input.reason }),
        },
      },
    ],
    projections: [workRequestListProjection(resourceId, nextState)],
    response: { resourceId, status: nextState.status },
  };
};

export const workRequestResource = defineResource({
  name: "workRequest",
  title: "Work Request",
  state: defineState({
    title: field.string({ required: true, label: "Title" }),
    description: field.text({ label: "Description" }),
    status: field.enum({
      label: "Status",
      values: workRequestStatusValues,
      defaultValue: "open",
    }),
    assigneeId: field.string({ label: "Assignee" }),
    updatedAt: field.datetime({ required: true, label: "Updated" }),
  }),
  commands: {
    create: defineCommand({
      title: "Create Work Request",
      input: createWorkRequestInput,
      roles: ["user"],
      emits: [{ eventType: "workRequest.created", schemaVersion: 1 }],
      create: true,
      decide: createWorkRequest,
    }),
    assign: defineCommand({
      title: "Assign",
      input: assignWorkRequestInput,
      roles: ["manager"],
      emits: [{ eventType: "workRequest.assigned", schemaVersion: 1 }],
      decide: assignWorkRequest,
    }),
    changeStatus: defineCommand({
      title: "Change Status",
      input: changeWorkRequestStatusInput,
      roles: ["manager"],
      emits: [{ eventType: "workRequest.statusChanged", schemaVersion: 1 }],
      decide: changeWorkRequestStatus,
    }),
    comment: defineCommand({
      title: "Comment",
      input: commentWorkRequestInput,
      roles: ["user"],
      emits: [{ eventType: "workRequest.commentAdded", schemaVersion: 1 }],
      decide: commentWorkRequest,
    }),
    close: defineCommand({
      title: "Close",
      input: closeWorkRequestInput,
      roles: ["manager"],
      emits: [{ eventType: "workRequest.closed", schemaVersion: 1 }],
      decide: closeWorkRequest,
    }),
  },
  views: {
    list: defineListView({
      title: "Work Requests",
      columns: ["title", "status", "assigneeId", "updatedAt"],
    }),
    detail: defineDetailView({
      titleField: "title",
      sections: ["summary", "activity", "comments"],
    }),
  },
});

export async function executeCommand<TResponse = unknown>(
  request: CommandRequest,
  options: CommandExecutorOptions,
): Promise<CommandExecutionResult<TResponse>> {
  const ids = createIdGenerator(options.ids);
  const requestId = request.requestId ?? ids.requestId();
  const correlationId = request.correlationId ?? ids.correlationId();
  const registry = normalizeRegistry(options.registry);
  const now = options.clock?.() ?? new Date();
  const nowIso = now.toISOString();
  const source = options.source ?? "jawstack";

  try {
    const auth = await options.authProvider.resolve(request.requestContext);
    assertAuthContext(auth);

    const resource = registry.getResource(request.resourceType);

    if (resource === undefined) {
      return apiError(
        "command.rejected",
        `Unknown resource "${request.resourceType}".`,
        requestId,
        correlationId,
      );
    }

    const command = findCommand(resource, request.commandName);

    if (command === undefined) {
      return apiError(
        "command.rejected",
        `Unknown command "${request.commandName}" for resource "${request.resourceType}".`,
        requestId,
        correlationId,
      );
    }

    const isAllowed = command.roles.some((role) => auth.roles.includes(role));

    if (!isAllowed) {
      return apiError(
        "auth.forbidden",
        "Auth context does not include a required role.",
        requestId,
        correlationId,
      );
    }

    const parsedInput = command.input.safeParse(request.input);

    if (!parsedInput.success) {
      return apiError(
        "command.validation",
        "Command input failed validation.",
        requestId,
        correlationId,
        parsedInput.error.issues,
      );
    }

    const idempotencyKey = request.idempotencyKey?.trim();

    if (request.idempotencyKey !== undefined && idempotencyKey === "") {
      return apiError(
        "command.rejected",
        "Idempotency key must be non-empty when provided.",
        requestId,
        correlationId,
      );
    }

    const idempotencyFingerprint =
      idempotencyKey === undefined
        ? undefined
        : createIdempotencyFingerprint({
            resourceType: request.resourceType,
            resourceId: request.resourceId,
            commandName: request.commandName,
            input: parsedInput.data,
          });

    if (idempotencyKey !== undefined && idempotencyFingerprint !== undefined) {
      const existing = await options.repository.getIdempotency?.(idempotencyKey);

      if (existing !== undefined) {
        if (existing.fingerprint !== idempotencyFingerprint) {
          return apiError(
            "idempotency.conflict",
            "Idempotency key was already used for a different command payload.",
            requestId,
            correlationId,
          );
        }

        return existing.response as ApiSuccess<TResponse>;
      }
    }

    const resourceId = command.create
      ? (request.resourceId ?? ids.resourceId(request.resourceType))
      : request.resourceId;

    if (resourceId === undefined || resourceId.trim().length === 0) {
      return apiError(
        "command.rejected",
        "Command requires a resource ID.",
        requestId,
        correlationId,
      );
    }

    const previous = command.create
      ? undefined
      : await options.repository.getState(request.resourceType, resourceId);

    if (!command.create && previous === undefined) {
      return apiError(
        "resource.not_found",
        `Resource "${request.resourceType}" with ID "${resourceId}" was not found.`,
        requestId,
        correlationId,
      );
    }

    const decide = getCommandDecide(command);
    const decision = await decide({
      auth,
      input: parsedInput.data,
      previous,
      resourceId,
      requestId,
      correlationId,
      now,
      ids,
    });

    assertDecision(decision, command);

    const next = buildNextResourceState({
      resourceType: request.resourceType,
      resourceId,
      previous,
      nextState: decision.nextState,
      auth,
      nowIso,
    });

    const activity = buildActivityRecords({
      drafts: decision.activity,
      resourceType: request.resourceType,
      resourceId,
      auth,
      nowIso,
      correlationId,
      causationId: requestId,
      ids,
    });

    const outbox = buildEvents({
      drafts: decision.events,
      source,
      resourceType: request.resourceType,
      resourceId,
      auth,
      nowIso,
      correlationId,
      causationId: requestId,
      ids,
    });

    const success = apiSuccess(decision.response as TResponse, requestId, correlationId);

    await options.unitOfWork.commit({
      resource: {
        resourceType: request.resourceType,
        resourceId,
        ...(previous === undefined ? {} : { expectedVersion: previous.version }),
        next,
        create: command.create,
      },
      activity,
      outbox,
      projections: decision.projections ?? [],
      response: decision.response,
      ...(idempotencyKey === undefined || idempotencyFingerprint === undefined
        ? {}
        : {
            idempotency: {
              key: idempotencyKey,
              fingerprint: idempotencyFingerprint,
              response: success,
            },
          }),
    });

    return success;
  } catch (error) {
    return runtimeErrorToApiError(error, requestId, correlationId);
  }
}
