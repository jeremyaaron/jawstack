import { GetItemCommand, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import type { DynamoDbClientLike, DynamoDbItem } from "@jawstack/aws-runtime";
import { JawStackRuntimeError } from "@jawstack/core";
import {
  jobNameSchema,
  jobRecordSchema,
  newJobLease,
  savedJobRecord,
  type JobName,
  type JobStore,
} from "../application/job-store";

export const jobKey = (name: JobName) => ({
  PK: `JOB#${jobNameSchema.parse(name)}`,
  SK: "CHECKPOINT",
});
export function createDynamoJobStore(options: {
  client: DynamoDbClientLike;
  tableName: string;
}): JobStore {
  const put = async (
    record: ReturnType<typeof jobRecordSchema.parse>,
    condition: string,
    values: Record<string, unknown>,
    names: Record<string, string> = {},
  ) =>
    options.client.send(
      new PutItemCommand({
        TableName: options.tableName,
        Item: marshall({ ...jobKey(record.name), itemKind: "APP_JOB", ...record }),
        ConditionExpression: condition,
        ...(Object.keys(values).length ? { ExpressionAttributeValues: marshall(values) } : {}),
        ...(Object.keys(names).length ? { ExpressionAttributeNames: names } : {}),
      }),
    );
  const conditional = (error: unknown) =>
    error instanceof Error && error.name === "ConditionalCheckFailedException";
  return {
    acquire: async (name, now) => {
      const key = jobKey(name);
      try {
        const result = (await options.client.send(
          new GetItemCommand({
            TableName: options.tableName,
            Key: marshall(key),
            ConsistentRead: true,
          }),
        )) as { Item?: DynamoDbItem };
        let old;
        if (result.Item) {
          const { PK, SK, itemKind, ...data } = unmarshall(result.Item);
          if (PK !== key.PK || SK !== key.SK || itemKind !== "APP_JOB")
            throw new JawStackRuntimeError(
              "resource.invalid_state",
              "Invalid job checkpoint identity.",
            );
          old = jobRecordSchema.parse(data);
          if (old.name !== name)
            throw new JawStackRuntimeError(
              "resource.invalid_state",
              "Invalid job checkpoint name.",
            );
        }
        if (old?.leaseUntil && old.leaseUntil > now.toISOString()) return undefined;
        const lease = newJobLease(name, old, now);
        await put(
          lease,
          old
            ? "#revision = :revision AND (attribute_type(#until, :nullType) OR #until <= :now)"
            : "attribute_not_exists(PK)",
          old ? { ":revision": old.revision, ":nullType": "NULL", ":now": now.toISOString() } : {},
          old ? { "#revision": "revision", "#until": "leaseUntil" } : {},
        );
        return lease;
      } catch (error) {
        if (conditional(error)) return undefined;
        if (error instanceof JawStackRuntimeError) throw error;
        throw new JawStackRuntimeError("runtime.unavailable", "Job checkpoint acquisition failed.");
      }
    },
    save: async (lease, progress, now, release) => {
      const record = savedJobRecord(lease, progress, now, release);
      try {
        await put(
          record,
          "#token = :token AND #revision = :revision AND #started <= :now AND #until > :now",
          { ":token": lease.token, ":revision": lease.revision, ":now": now.toISOString() },
          {
            "#token": "token",
            "#revision": "revision",
            "#started": "startedAt",
            "#until": "leaseUntil",
          },
        );
      } catch (error) {
        throw new JawStackRuntimeError(
          conditional(error) ? "resource.conflict" : "runtime.unavailable",
          "Job checkpoint write failed.",
        );
      }
    },
  };
}
