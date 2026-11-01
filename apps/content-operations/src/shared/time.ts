import { Temporal } from "@js-temporal/polyfill";
import { z } from "zod";
import { instantSchema, timeZoneSchema } from "./validation";

// Browser-safe conversion: never choose an offset for an ambiguous/nonexistent local time.
export function localTimeToUtc(localDateTime: string, timeZone: string): string {
  const local = z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?$/)
    .parse(localDateTime);
  const zone = timeZoneSchema.parse(timeZone);
  const instant = Temporal.PlainDateTime.from(local, { overflow: "reject" })
    .toZonedDateTime(zone, { disambiguation: "reject" })
    .toInstant();
  return instantSchema.parse(instant.toString({ fractionalSecondDigits: 3 }));
}

export function utcToLocal(instant: string, timeZone: string): string {
  return Temporal.Instant.from(instantSchema.parse(instant))
    .toZonedDateTimeISO(timeZoneSchema.parse(timeZone))
    .toPlainDateTime()
    .toString({ fractionalSecondDigits: 3 });
}
export function localDateAt(instant: string, timeZone: string): string {
  return utcToLocal(instant, timeZone).slice(0, 10);
}
export function zonedLabel(instant: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en", {
    timeZone: timeZoneSchema.parse(timeZone),
    dateStyle: "medium",
    timeStyle: "long",
  }).format(new Date(instantSchema.parse(instant)));
}
export function timeZones(current = "UTC"): string[] {
  return [...new Set(["UTC", current, ...Intl.supportedValuesOf("timeZone")])];
}
