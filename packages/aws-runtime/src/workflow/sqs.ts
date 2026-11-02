import { z } from "zod";
import {
  copyWorkflowJson,
  JawStackDefinitionError,
  JawStackRuntimeError,
  type WorkflowRuntime,
} from "@jawstack/core";
import type { SqsWorkerResult } from "../index";

const queueArn = z
  .string()
  .max(256)
  .regex(
    /^arn:aws(?:-us-gov|-cn)?:sqs:[a-z]{2}(?:-[a-z]+)+-\d:\d{12}:[A-Za-z0-9_-]{1,80}(?:\.fifo)?$/,
  )
  .refine((value) => value.split(":").at(-1)!.length <= 80);
export type WorkflowSqsOptions = Readonly<{
  runtime: WorkflowRuntime;
  consumer: string;
  sourceQueueArn: string;
  deadLetterQueueArn: string;
}>;

export function createWorkflowSqsHandlers(options: WorkflowSqsOptions) {
  if (
    !options ||
    typeof options !== "object" ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(options)) ||
    Reflect.ownKeys(options).some(
      (key) =>
        typeof key !== "string" ||
        !["runtime", "consumer", "sourceQueueArn", "deadLetterQueueArn"].includes(key) ||
        !("value" in Object.getOwnPropertyDescriptor(options, key)!),
    )
  )
    throw new JawStackDefinitionError(
      "workflow.sqs",
      "An exact consumer/source/DLQ binding is required.",
    );
  const { runtime, consumer, sourceQueueArn, deadLetterQueueArn } = options;
  const policy = runtime?.manifest?.consumers.find((item) => item.name === consumer);
  if (
    !policy ||
    !queueArn.safeParse(sourceQueueArn).success ||
    !queueArn.safeParse(deadLetterQueueArn).success ||
    sourceQueueArn === deadLetterQueueArn ||
    sourceQueueArn.split(":").slice(0, 5).join(":") !==
      deadLetterQueueArn.split(":").slice(0, 5).join(":")
  )
    throw new JawStackDefinitionError(
      "workflow.sqs",
      "An exact consumer/source/DLQ binding is required.",
    );
  const maximumBody = runtime.manifest.eventBytes * 2 + 16384;
  const schema = z.object({
    Records: z
      .array(
        z.object({
          messageId: z.string().min(1).max(128),
          body: z.string().min(1).max(maximumBody),
          eventSourceARN: z.string(),
          eventSource: z.literal("aws:sqs"),
          awsRegion: z.string(),
        }),
      )
      .min(1)
      .max(policy.batchSize),
  });
  const handler =
    (collect: boolean) =>
    async (input: unknown): Promise<SqsWorkerResult> => {
      let wires: ReturnType<WorkflowRuntime["events"]["parse"]>[];
      try {
        // Capture the complete transport before the first await. Metadata is bounded too.
        const batch = schema.parse(
          copyWorkflowJson(input, policy.batchSize * (maximumBody * 6 + 16384)),
        );
        const expectedArn = collect ? deadLetterQueueArn : sourceQueueArn;
        if (new Set(batch.Records.map((record) => record.messageId)).size !== batch.Records.length)
          throw new Error();
        wires = batch.Records.map((record) => {
          if (
            record.eventSourceARN !== expectedArn ||
            record.awsRegion !== expectedArn.split(":")[3] ||
            Buffer.byteLength(record.body) > maximumBody
          )
            throw new Error();
          return runtime.events.parse(JSON.parse(record.body));
        });
      } catch {
        throw new JawStackRuntimeError("command.validation", "Invalid workflow delivery batch.");
      }
      // Validate/authorize *every* fact before the first marker or effect, even on duplicates.
      for (const wire of wires) {
        if (collect) await runtime.delivery.validateCollection(consumer, wire);
        else await runtime.delivery.validate(consumer, wire);
      }
      let processed = 0,
        skipped = 0;
      for (const wire of wires) {
        const result = collect
          ? await runtime.delivery.collect(consumer, wire)
          : await runtime.delivery.handle(consumer, wire);
        if (result.status === "deferred")
          throw new JawStackRuntimeError("runtime.unavailable", "Workflow delivery is deferred.");
        if (result.status === "processed") processed++;
        else skipped++;
      }
      return { seen: wires.length, processed, skipped };
    };
  return Object.freeze({ worker: handler(false), collector: handler(true) });
}
