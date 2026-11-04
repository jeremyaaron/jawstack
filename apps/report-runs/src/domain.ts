import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  defineCommand,
  defineResource,
  defineState,
  defineWorker,
  field,
  JawStackRuntimeError,
  type ResourceState,
} from "@jawstack/core";

export const limits = Object.freeze({ inputBytes: 16384, resultBytes: 32768, bodyBytes: 20480 });
export const uuid = z.uuid();
export const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const instant = z.iso.datetime({ precision: 3 });
export const keySchema = z.string().regex(/^[A-Za-z0-9_.:-]{1,200}$/);
export const workerIdentity = Object.freeze({
  subject: "report-worker",
  roles: ["reportWorker"],
  mode: "dev" as const,
  claims: {},
});
const validUnicode = (text: string) =>
  [...text].every((char) => {
    const code = char.codePointAt(0)!;
    return code < 0xd800 || code > 0xdfff;
  });
const labelSchema = z
  .string()
  .refine(validUnicode, "Invalid Unicode.")
  .refine((text) => !/\p{Cc}/u.test(text), "Control characters are not allowed.")
  .transform((text) => text.trim().normalize("NFC"))
  .pipe(
    z
      .string()
      .min(1)
      .refine((text) => Buffer.byteLength(text) <= 160, "Label exceeds 160 UTF-8 bytes."),
  );
const itemSchema = z.strictObject({
  itemId: z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/),
  label: labelSchema,
  quantity: z
    .number()
    .int()
    .min(0)
    .max(1_000_000)
    .transform((n) => (n === 0 ? 0 : n)),
});
export const inventorySchema = z
  .strictObject({ items: z.array(itemSchema).min(1).max(100) })
  .transform((value) => ({
    items: [...value.items].sort((a, b) =>
      Buffer.compare(Buffer.from(a.itemId), Buffer.from(b.itemId)),
    ),
  }))
  .superRefine((value, ctx) => {
    if (new Set(value.items.map((item) => item.itemId)).size !== value.items.length)
      ctx.addIssue({ code: "custom", message: "Item IDs must be unique." });
    if (Buffer.byteLength(JSON.stringify(value)) > limits.inputBytes)
      ctx.addIssue({ code: "custom", message: "Inventory exceeds 16 KiB." });
    const total = value.items.reduce((sum, item) => sum + item.quantity, 0);
    if (!Number.isSafeInteger(total) || total > 100_000_000)
      ctx.addIssue({ code: "custom", message: "Unsafe aggregate." });
  });
export type Inventory = z.infer<typeof inventorySchema>;
export const bytes = (value: unknown) => Buffer.from(JSON.stringify(value) + "\n", "utf8");
export const sha256 = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
export const inputDigest = (input: Inventory) => sha256(bytes(input));
export const resultSchema = z.strictObject({
  version: z.literal(1),
  reportId: uuid,
  requestedAt: instant,
  items: z.array(itemSchema).min(1).max(100),
  summary: z.strictObject({
    itemCount: z.number().int().min(1).max(100),
    totalQuantity: z.number().int().min(0).max(100_000_000),
    zeroStockCount: z.number().int().min(0).max(100),
  }),
});
export type ReportResult = z.infer<typeof resultSchema>;
export function calculate(reportId: string, requestedAt: string, input: Inventory): ReportResult {
  return {
    version: 1,
    reportId: uuid.parse(reportId),
    requestedAt: instant.parse(requestedAt),
    items: inventorySchema.parse(input).items,
    summary: {
      itemCount: input.items.length,
      totalQuantity: input.items.reduce((sum, item) => sum + item.quantity, 0),
      zeroStockCount: input.items.filter((item) => item.quantity === 0).length,
    },
  };
}
export function serializeResult(value: unknown) {
  const result = resultSchema.parse(value);
  const canonical = calculate(result.reportId, result.requestedAt, { items: result.items });
  if (JSON.stringify(result) !== JSON.stringify(canonical))
    throw new JawStackRuntimeError(
      "resource.invalid_state",
      "Stored report result is not canonical.",
    );
  const output = bytes(result);
  if (output.byteLength > limits.resultBytes)
    throw new JawStackRuntimeError("command.validation", "Report result exceeds 32 KiB.");
  return { result, bytes: output, digest: sha256(output) };
}
const baseState = z.strictObject({
  reportId: uuid,
  requester: z.enum(["requester_1", "requester_2", "operator_1"]),
  requestedAt: instant,
  input: inventorySchema,
  inputDigest: digestSchema,
});
export const reportStateSchema = z.discriminatedUnion("status", [
  baseState.extend({ status: z.literal("requested") }),
  baseState.extend({
    status: z.literal("completed"),
    result: resultSchema,
    resultDigest: digestSchema,
    completedAt: instant,
  }),
]);
export type ReportState = z.infer<typeof reportStateSchema>;
export function readReport(row: ResourceState | undefined, id: string) {
  if (!row) throw new JawStackRuntimeError("resource.not_found", "Report was not found.");
  try {
    const state = reportStateSchema.parse(row.state);
    if (
      row.resourceType !== "reportRun" ||
      row.resourceId !== id ||
      state.reportId !== id ||
      row.createdAt !== state.requestedAt ||
      row.createdBy !== state.requester ||
      row.updatedBy !== (state.status === "completed" ? workerIdentity.subject : state.requester) ||
      (state.status === "requested" && row.updatedAt !== state.requestedAt) ||
      inputDigest(state.input) !== state.inputDigest ||
      !isDeepStrictEqual(state, row.state) ||
      row.version !== (state.status === "requested" ? 1 : 2)
    )
      throw new Error();
    if (state.status === "completed") {
      const serialized = serializeResult(state.result);
      const expected = serializeResult(calculate(id, state.requestedAt, state.input));
      if (
        serialized.digest !== state.resultDigest ||
        expected.digest !== state.resultDigest ||
        state.completedAt !== row.updatedAt ||
        state.completedAt < state.requestedAt
      )
        throw new Error();
    }
    return { ...row, state };
  } catch {
    throw new JawStackRuntimeError("resource.invalid_state", "Stored report authority is invalid.");
  }
}
export const requestedFact = z.strictObject({
  reportId: uuid,
  inputDigest: digestSchema,
  requestedAt: instant,
});
export const completedFact = requestedFact.extend({ resultDigest: digestSchema });
export const reportResource = defineResource({
  name: "reportRun",
  title: "Report Run",
  state: defineState({
    status: field.enum({ values: ["requested", "completed"] }),
    requester: field.string(),
    requestedAt: field.datetime(),
  }),
  commands: {
    request: defineCommand({
      title: "Request inventory report",
      create: true,
      roles: ["requester", "operator"],
      input: inventorySchema,
      emits: [{ eventType: "reportRun.requested", schemaVersion: 1 }],
      decide: ({ auth, input, resourceId, now }) => {
        const state = reportStateSchema.parse({
          status: "requested",
          reportId: resourceId,
          requester: auth.subject,
          requestedAt: now.toISOString(),
          input,
          inputDigest: inputDigest(input),
        });
        serializeResult(calculate(resourceId, state.requestedAt, input));
        return {
          nextState: state,
          response: { reportId: resourceId, status: state.status, inputDigest: state.inputDigest },
          activity: [{ activityType: "requested", title: "Requested inventory report" }],
          events: [
            {
              eventType: "reportRun.requested",
              schemaVersion: 1,
              payload: {
                reportId: resourceId,
                inputDigest: state.inputDigest,
                requestedAt: state.requestedAt,
              },
            },
          ],
        };
      },
    }),
    complete: defineCommand({
      title: "Complete inventory report",
      roles: ["reportWorker"],
      input: z.strictObject({
        expectedVersion: z.literal(1),
        reportId: uuid,
        requestedAt: instant,
        inputDigest: digestSchema,
        result: resultSchema,
        resultDigest: digestSchema,
      }),
      emits: [{ eventType: "reportRun.completed", schemaVersion: 1 }],
      decide: ({ auth, input, resourceId, previous, now }) => {
        if (auth.subject !== workerIdentity.subject || auth.mode !== "dev")
          throw new JawStackRuntimeError(
            "auth.forbidden",
            "Only the internal report worker can complete reports.",
          );
        const row = readReport(previous, resourceId),
          state = row.state;
        if (row.version !== input.expectedVersion || state.status !== "requested")
          throw new JawStackRuntimeError("resource.conflict", "Report authority changed.");
        const result = serializeResult(input.result);
        const expected = serializeResult(calculate(resourceId, state.requestedAt, state.input));
        if (
          input.reportId !== resourceId ||
          input.requestedAt !== state.requestedAt ||
          input.inputDigest !== state.inputDigest ||
          input.resultDigest !== expected.digest ||
          result.digest !== expected.digest
        )
          throw new JawStackRuntimeError(
            "command.rejected",
            "Completion differs from the immutable request.",
          );
        return {
          nextState: {
            ...state,
            status: "completed",
            result: result.result,
            resultDigest: result.digest,
            completedAt: now.toISOString(),
          },
          response: { reportId: resourceId, resultDigest: result.digest },
          activity: [{ activityType: "completed", title: "Completed inventory report" }],
          events: [
            {
              eventType: "reportRun.completed",
              schemaVersion: 1,
              payload: {
                reportId: resourceId,
                requestedAt: state.requestedAt,
                inputDigest: state.inputDigest,
                resultDigest: result.digest,
              },
            },
          ],
        };
      },
    }),
  },
  workers: [
    defineWorker({
      name: "buildInventory",
      eventTypes: ["reportRun.requested"],
      maxConcurrency: 2,
    }),
  ],
});
