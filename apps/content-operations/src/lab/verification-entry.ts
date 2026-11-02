import { z } from "zod";
import type { SqsEvent } from "@jawstack/aws-runtime";
import { localLambdaConfig } from "../aws/local-context";
import { executePublication } from "../aws/publication";
import { executeRecovery } from "../aws/recovery";
import { deliveryQueueName } from "../aws/delivery";
import { contentSqsHandlers } from "../aws/recovery";
import { createClients, destroyClients } from "./clients";
import { queueArn } from "./capabilities";
import { consumerSchema } from "../application/failure-records";
import { parseContentEvent } from "../shared/events";
import { verificationHooks } from "./verification-state";

async function execute(event: SqsEvent, kind: "publisher" | "worker" | "collector") {
  const config = localLambdaConfig(kind);
  const ownerId = z.uuid().parse(process.env.CONTENT_OPS_OWNER_ID);
  const consumer =
    kind === "publisher"
      ? "publishContent"
      : consumerSchema.parse(process.env.CONTENT_OPS_CONSUMER);
  const clients = createClients(config);
  try {
    const batch = contentSqsHandlers(
      {
        client: clients.dynamo,
        tableName: config.table,
        handle: async () => {},
        expectedQueueArn: queueArn(
          config,
          deliveryQueueName(config, consumer, kind === "collector"),
        ),
        consumer,
        source: config.source,
      },
      kind === "collector",
    ).parse(event, kind === "collector");
    const fact = parseContentEvent(batch[0]!, config.source);
    const original = z
      .object({
        Records: z.array(
          z.object({
            attributes: z.object({
              ApproximateReceiveCount: z.coerce.number().int().min(1).max(100),
            }),
          }),
        ),
      })
      .parse(event).Records[0]!;
    const fault = await verificationHooks({
      client: clients.dynamo,
      table: config.table,
      ownerId,
      consumer,
      fact,
      messageId: event.Records![0]!.messageId,
      receiveCount: original.attributes.ApproximateReceiveCount,
      collector: kind === "collector",
    });
    if (kind === "publisher")
      return await executePublication(
        event,
        fault ? { before: () => fault("before"), fault: (_fact, point) => fault(point) } : {},
      );
    return await executeRecovery(
      event,
      kind === "collector",
      fault ? { before: () => fault("before"), fault } : {},
    );
  } finally {
    destroyClients(clients);
  }
}
export const publisher = (event: SqsEvent) => execute(event, "publisher");
export const worker = (event: SqsEvent) => execute(event, "worker");
export const collector = (event: SqsEvent) => execute(event, "collector");
