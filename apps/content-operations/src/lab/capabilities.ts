import { GetScheduleCommand, UpdateScheduleCommand } from "@aws-sdk/client-scheduler";
import { LabError, type LabConfig } from "./config";
import type { LabClients } from "./clients";

export const queueArn = (config: LabConfig, name: string) =>
  `arn:aws:sqs:${config.region}:000000000000:${name}`;

export const functionArn = (config: LabConfig, name: string) =>
  `arn:aws:lambda:${config.region}:000000000000:function:${name}`;

export const schedulerRoleArn = (config: LabConfig) =>
  `arn:aws:iam::000000000000:role/${config.schedulerRole}`;

export async function setSchedule(
  c: LabClients,
  config: LabConfig,
  runId: string,
  enabled: boolean,
) {
  const current = await c.scheduler.send(
    new GetScheduleCommand({ Name: config.schedule, GroupName: config.scheduleGroup }),
  );
  if (
    current.Target?.Arn !== functionArn(config, config.scheduled) ||
    current.Target.RoleArn !== schedulerRoleArn(config)
  )
    throw new LabError("Unexpected scheduler target; refusing update.");
  await c.scheduler.send(
    new UpdateScheduleCommand({
      Name: config.schedule,
      GroupName: config.scheduleGroup,
      ScheduleExpression: "rate(1 minute)",
      FlexibleTimeWindow: { Mode: "OFF" },
      State: enabled ? "ENABLED" : "DISABLED",
      Target: { ...current.Target, Input: JSON.stringify({ targetHandler: "spineTick", runId }) },
    }),
  );
}
