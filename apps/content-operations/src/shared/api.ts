import { z } from "zod";
import { contentStatuses, reviewStatuses } from "./contracts";
import { fixtureIds, editorIds } from "./identities";
import { idSchema, offsetInstantSchema } from "./validation";

export const pageInput = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(4096).optional(),
});
const titleFilter = z
  .string()
  .trim()
  .max(160)
  .transform((value) => value.normalize("NFC").toLowerCase());
export const contentQueryInput = pageInput.extend({
  status: z.enum(contentStatuses).optional(),
  authorId: z.enum(fixtureIds).optional(),
  title: titleFilter.optional(),
});
export const reviewQueryInput = pageInput.extend({
  contentId: idSchema.optional(),
  status: z.enum(reviewStatuses).optional(),
  editorId: z.enum(editorIds).optional(),
  overdue: z.enum(["true", "false"]).default("false"),
});
export const calendarQueryInput = pageInput
  .extend({ from: offsetInstantSchema, before: offsetInstantSchema })
  .refine(
    (q) =>
      Date.parse(q.before) > Date.parse(q.from) &&
      Date.parse(q.before) - Date.parse(q.from) <= 42 * 86_400_000,
    "Calendar range must be positive and at most 42 days.",
  );
export const operationsQueryInput = pageInput
  .extend({
    view: z.enum(["attempts", "notifications", "failures"]).default("attempts"),
    contentId: idSchema.optional(),
    recipientId: z.enum(fixtureIds).optional(),
    status: z
      .enum([
        "claimed",
        "succeeded",
        "failed",
        "expired",
        "reconciling",
        "replayQueued",
        "resolved",
      ])
      .optional(),
  })
  .refine(
    (q) => q.recipientId === undefined || q.view === "notifications",
    "Recipient applies only to notifications.",
  );
type QueryInput<T extends z.ZodType> = Omit<z.input<T>, "limit"> & { limit?: number };
export type ContentQuery = QueryInput<typeof contentQueryInput>;
export type ReviewQuery = QueryInput<typeof reviewQueryInput>;
export type CalendarQuery = QueryInput<typeof calendarQueryInput>;
export type OperationsQuery = QueryInput<typeof operationsQueryInput>;
type PrivateKey = "objectKey" | "fencingToken";
export type PublicValue<T> = T extends readonly (infer U)[]
  ? PublicValue<U>[]
  : T extends object
    ? { [K in keyof T as K extends PrivateKey ? never : K]: PublicValue<T[K]> }
    : T;
export function publicValue<T>(value: T): PublicValue<T> {
  if (Array.isArray(value)) return value.map((item) => publicValue(item)) as PublicValue<T>;
  if (typeof value === "object" && value !== null)
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== "objectKey" && key !== "fencingToken")
        .map(([key, item]) => [key, publicValue(item)]),
    ) as PublicValue<T>;
  return value as PublicValue<T>;
}
