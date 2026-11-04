import { z } from "zod";
import { parseLocalWorkflowBindings } from "@jawstack/aws-runtime/local";
import { reportDefinition } from "./workflow";
export function topology(labId: string) {
  z.string()
    .regex(/^[a-z][a-z0-9-]{0,15}$/)
    .parse(labId);
  const project = "jawstack-report-runs-" + labId;
  return Object.freeze({
    labId,
    project,
    source: "report-runs." + labId,
    table: project + "-state",
    bus: project + "-events",
    queue: project + "-inventory",
    dlq: project + "-inventory-dlq",
    dispatcher: project + "-outbox",
    worker: project + "-worker",
    collector: project + "-collector",
  });
}
export function localBindings(input: {
  labId: string;
  ownerId: string;
  profileHash: string;
  layout?: "lab" | "cdk";
}) {
  const t = topology(input.labId),
    definition = reportDefinition(t.source);
  const project = input.layout === "cdk" ? t.project + "-local" : t.project;
  const functions =
    input.layout === "cdk"
      ? [
          { name: project + "-outbox-dispatcher", role: "dispatcher" },
          { name: project + "-outbox-sweeper", role: "proof" },
          { name: project + "-api", role: "api" },
          { name: project + "-buildinventory-worker", role: "worker", consumer: "buildInventory" },
          {
            name: project + "-buildinventory-collector",
            role: "collector",
            consumer: "buildInventory",
          },
        ]
      : [
          { name: t.dispatcher, role: "dispatcher" },
          { name: t.worker, role: "worker", consumer: "buildInventory" },
          { name: t.collector, role: "collector", consumer: "buildInventory" },
        ];
  return parseLocalWorkflowBindings({
    schemaVersion: 1,
    workflow: { name: definition.manifest.name, source: t.source, hash: definition.manifest.hash },
    profile: { name: project, hash: input.profileHash },
    lab: { id: t.labId, project, ownerId: input.ownerId },
    accountId: "000000000000",
    region: "us-east-1",
    tableName: input.layout === "cdk" ? project + "-resources" : t.table,
    eventBusName: input.layout === "cdk" ? project + "-events" : t.bus,
    functions,
    consumers: [
      {
        consumer: "buildInventory",
        sourceQueueArn:
          "arn:aws:sqs:us-east-1:000000000000:" +
          (input.layout === "cdk" ? project + "-buildinventory-queue" : t.queue),
        deadLetterQueueArn:
          "arn:aws:sqs:us-east-1:000000000000:" +
          (input.layout === "cdk" ? project + "-buildinventory-dlq" : t.dlq),
      },
    ],
  });
}
