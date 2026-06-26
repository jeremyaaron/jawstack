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
  input: TInput;
  roles: readonly string[];
  emits: readonly EventDeclaration[];
  create: boolean;
  decide: unknown;
  response?: TResponse;
}>;

export type DefineCommandInput<TInput = unknown, TResponse = unknown> = Readonly<{
  title: string;
  input: TInput;
  roles: readonly string[];
  emits: readonly EventDeclaration[];
  create?: boolean;
  decide: unknown;
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

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }

  Object.freeze(value);

  for (const nested of Object.values(value)) {
    deepFreeze(nested);
  }

  return value;
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
