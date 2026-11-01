import { Temporal } from "@js-temporal/polyfill";
import { z } from "zod";
import { pageInput, calendarQueryInput } from "./api";
import { timeZoneSchema } from "./validation";
import { localDateAt } from "./time";

export const calendarDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    try {
      const date = Temporal.PlainDate.from(value, { overflow: "reject" });
      return date.year >= 1 && date.year <= 9998;
    } catch {
      return false;
    }
  });
export const calendarStateSchema = pageInput.extend({
  date: calendarDateSchema,
  zone: timeZoneSchema,
  view: z.enum(["month", "agenda"]).default("month"),
});
export type CalendarState = z.infer<typeof calendarStateSchema>;
export function calendarState(input: Record<string, unknown>, now = new Date()): CalendarState {
  const zone = timeZoneSchema.parse(input["zone"] ?? "UTC");
  return calendarStateSchema.parse({
    ...input,
    zone,
    date: input["date"] ?? localDateAt(now.toISOString(), zone),
  });
}
export function calendarMonth(date: string, zone: string) {
  const selected = Temporal.PlainDate.from(calendarDateSchema.parse(date));
  const start = selected.with({ day: 1 });
  const next = start.add({ months: 1 });
  const timeZone = timeZoneSchema.parse(zone);
  // Calendar bounds use the first valid instant of a day, even where midnight was skipped.
  const query = calendarQueryInput.parse({
    from: start.toZonedDateTime(timeZone).toInstant().toString({ fractionalSecondDigits: 3 }),
    before: next.toZonedDateTime(timeZone).toInstant().toString({ fractionalSecondDigits: 3 }),
  });
  const gridStart = start.subtract({ days: start.dayOfWeek - 1 });
  return {
    title: start.toLocaleString("en", { month: "long", year: "numeric" }),
    query,
    days: Array.from({ length: 42 }, (_, n) => {
      const day = gridStart.add({ days: n });
      return {
        date: day.toString(),
        day: day.day,
        inMonth: day.month === start.month,
        label: day.toLocaleString("en", { dateStyle: "full" }),
      };
    }),
  };
}
export function shiftCalendarMonth(date: string, months: number): string | undefined {
  const next = Temporal.PlainDate.from(calendarDateSchema.parse(date)).add({ months }).toString();
  return calendarDateSchema.safeParse(next).success ? next : undefined;
}
