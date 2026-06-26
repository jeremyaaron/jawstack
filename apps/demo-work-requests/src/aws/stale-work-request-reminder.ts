import {
  createSchedulerTargetAdapter,
  createStaleWorkRequestReminderHandler,
  type SchedulerEvent,
} from "@jawstack/aws-runtime";

import { createAwsRuntimeOptions } from "./runtime";

const runtimeOptions = createAwsRuntimeOptions();

const adapter = createSchedulerTargetAdapter({
  defaultHandler: "staleWorkRequestReminder",
  handlers: {
    staleWorkRequestReminder: createStaleWorkRequestReminderHandler({
      repository: runtimeOptions.repository,
    }),
  },
});

export async function handler(event: unknown): Promise<unknown> {
  return adapter(event as SchedulerEvent);
}
