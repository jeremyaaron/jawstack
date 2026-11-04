import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { EventBridgeClient } from "@aws-sdk/client-eventbridge";
import {
  createWorkflowSqsHandlers,
  DynamoDbOutboxDispatcher,
  DynamoDbOutboxSweeper,
  EventBridgePublisher,
  type DynamoDbStreamEvent,
} from "@jawstack/aws-runtime";
import { createLocalAwsTransport } from "@jawstack/aws-runtime/local";
import { createLocalReport } from "./workflow";
import { localBindings, topology } from "./local-config";
import { z } from "zod";
import { startReportApi, type ReportApplication } from "./server";
import { limits } from "./domain";
import { copyWorkflowJson } from "@jawstack/core";

type Context = { invokedFunctionArn: string };
async function local(
  role: "dispatcher" | "worker" | "collector" | "api" | "proof",
  context: Context,
) {
  const t = topology(process.env.REPORT_RUNS_LAB_ID ?? "");
  const bindings = localBindings({
    labId: t.labId,
    ownerId: process.env.REPORT_RUNS_OWNER_ID ?? "",
    profileHash: process.env.REPORT_RUNS_PROFILE_HASH ?? "",
    layout: z.enum(["lab", "cdk"]).parse(process.env.REPORT_RUNS_LAYOUT ?? "lab"),
  });
  const execution = {
    kind: "lambda" as const,
    functionName: bindings.functions.find((f) => f.role === role)!.name,
    role,
    invokedFunctionArn: context.invokedFunctionArn,
    ...(["worker", "collector"].includes(role) ? { consumer: "buildInventory" } : {}),
  };
  const workflow = await createLocalReport({
    source: t.source,
    bindings,
    profile: bindings.profile,
    lab: { id: t.labId, ownerId: bindings.lab.ownerId },
    execution,
  });
  return { t, bindings, execution, workflow };
}
export async function worker(event: unknown, context: Context) {
  const app = await local("worker", context);
  try {
    return await createWorkflowSqsHandlers({
      runtime: app.workflow,
      ...app.bindings.consumers[0]!,
    }).worker(event);
  } finally {
    await app.workflow.close();
  }
}
export async function collector(event: unknown, context: Context) {
  const app = await local("collector", context);
  try {
    return await createWorkflowSqsHandlers({
      runtime: app.workflow,
      ...app.bindings.consumers[0]!,
    }).collector(event);
  } finally {
    await app.workflow.close();
  }
}
async function publish(event: DynamoDbStreamEvent | undefined, context: Context) {
  const app = await local(event ? "dispatcher" : "proof", context);
  const transport = createLocalAwsTransport({ execution: app.execution });
  const dynamo = new DynamoDBClient(transport),
    events = new EventBridgeClient(transport);
  try {
    const publisher = new EventBridgePublisher({
      client: events,
      eventBusName: app.bindings.eventBusName,
      source: app.t.source,
    });
    return event
      ? await new DynamoDbOutboxDispatcher({
          dynamoDbClient: dynamo,
          tableName: app.bindings.tableName,
          publisher,
        }).dispatchStream(event)
      : await new DynamoDbOutboxSweeper({
          dynamoDbClient: dynamo,
          tableName: app.bindings.tableName,
          publisher,
        }).sweep();
  } finally {
    dynamo.destroy();
    events.destroy();
    transport.requestHandler.destroy();
    await app.workflow.close();
  }
}
export const dispatcher = (event: DynamoDbStreamEvent, context: Context) => publish(event, context);
export const sweeper = (_event: unknown, context: Context) => publish(undefined, context);

const gatewayEvent = z.object({
  rawPath: z.string().min(1).max(8192),
  rawQueryString: z.string().max(8192).default(""),
  headers: z.record(z.string(), z.string()).default({}),
  requestContext: z.object({ http: z.object({ method: z.enum(["GET", "POST"]) }) }),
  body: z
    .string()
    .max(limits.bodyBytes * 2)
    .optional(),
  isBase64Encoded: z.boolean().optional(),
});
export function createGatewayHandler(open: () => Promise<ReportApplication>) {
  return async (input: unknown) => {
    const event = gatewayEvent.parse(copyWorkflowJson(input, 80 * 1024));
    if (
      !event.rawPath.startsWith("/api/") ||
      event.rawPath.includes("?") ||
      event.rawPath.includes("#")
    )
      throw new Error("Invalid API path.");
    const payload =
      event.body === undefined
        ? undefined
        : Buffer.from(event.body, event.isBase64Encoded ? "base64" : "utf8");
    if (payload && payload.length > limits.bodyBytes) throw new Error("Request exceeds 20 KiB.");
    const app = await open(),
      api = await startReportApi(app, { port: 0, managed: false });
    try {
      const headers = Object.fromEntries(
        Object.entries(event.headers)
          .map(([k, v]) => [k.toLowerCase(), v])
          .filter(([k]) =>
            ["x-report-runs-fixture", "content-type", "x-request-id", "x-correlation-id"].includes(
              k!,
            ),
          ),
      );
      const response = await fetch(
        api.url + event.rawPath + (event.rawQueryString ? "?" + event.rawQueryString : ""),
        {
          method: event.requestContext.http.method,
          headers,
          redirect: "error",
          ...(payload ? { body: payload } : {}),
          signal: AbortSignal.timeout(30000),
        },
      );
      return {
        statusCode: response.status,
        headers: Object.fromEntries(response.headers),
        body: await response.text(),
        isBase64Encoded: false,
      };
    } finally {
      await api.close();
    }
  };
}
export const api = (event: unknown, context: Context) =>
  createGatewayHandler(async () => ({
    kind: "localstack",
    workflow: (await local("api", context)).workflow,
  }))(event);
