import {
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  TransactWriteItemsCommand,
  type TransactWriteItem,
} from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import type { DynamoDbClientLike, DynamoDbItem } from "../../src/index";

export const itemKey = (item: DynamoDbItem) => JSON.stringify([item.PK?.S, item.SK?.S]);
export class WorkflowClient implements DynamoDbClientLike {
  items = new Map<string, DynamoDbItem>();
  calls: { input: unknown }[] = [];
  before?: (command: { input: unknown }) => void | Promise<void>;
  after?: (command: { input: unknown }) => void | Promise<void>;
  put(item: DynamoDbItem) {
    this.items.set(itemKey(item), structuredClone(item));
  }
  async send(command: { input: unknown }): Promise<unknown> {
    this.calls.push(command);
    await this.before?.(command);
    if (command instanceof GetItemCommand) {
      if (command.input.ConsistentRead !== true) throw new Error("A workflow read was not strong.");
      const output = { Item: structuredClone(this.items.get(itemKey(command.input.Key!))) };
      await this.after?.(command);
      return output;
    }
    if (command instanceof QueryCommand) {
      if (command.input.ConsistentRead !== true)
        throw new Error("A workflow query was not strong.");
      const values = unmarshall(command.input.ExpressionAttributeValues!);
      const compare = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));
      let rows = [...this.items.values()]
        .filter(
          (row) =>
            row.PK?.S === values[":pk"] &&
            (!values[":prefix"] || row.SK?.S?.startsWith(values[":prefix"])) &&
            (!values[":bound"] ||
              (command.input.KeyConditionExpression!.includes(">=")
                ? compare(row.SK!.S!, values[":bound"]) >= 0
                : compare(row.SK!.S!, values[":bound"]) < 0)),
        )
        .sort((a, b) => compare(a.SK!.S!, b.SK!.S!));
      if (command.input.ScanIndexForward === false) rows.reverse();
      const after = command.input.ExclusiveStartKey?.SK?.S;
      if (after)
        rows = rows.filter((row) =>
          command.input.ScanIndexForward === false
            ? compare(row.SK!.S!, after) < 0
            : compare(row.SK!.S!, after) > 0,
        );
      const page = rows.slice(0, command.input.Limit);
      const last = rows.length > page.length ? page.at(-1) : undefined;
      return {
        Items: structuredClone(
          page.filter((row) => !values[":kind"] || row.itemKind?.S === values[":kind"]),
        ),
        ...(last ? { LastEvaluatedKey: { PK: last.PK, SK: last.SK } } : {}),
      };
    }
    const writes: TransactWriteItem[] =
      command instanceof TransactWriteItemsCommand
        ? command.input.TransactItems!
        : command instanceof PutItemCommand
          ? [{ Put: command.input }]
          : [];
    if (!writes.length) throw new Error("Unsupported workflow SDK command.");
    const keys = writes.map((write) => itemKey(write.Put?.Item ?? write.Delete!.Key!));
    if (new Set(keys).size !== keys.length) throw new Error("Duplicate physical action.");
    const reasons = writes.map((write, i) => {
      const put = write.Put,
        oldItem = this.items.get(keys[i]!),
        old = oldItem && unmarshall(oldItem),
        values = unmarshall(put?.ExpressionAttributeValues ?? {});
      let allowed = true;
      switch (put?.ConditionExpression) {
        case undefined:
          break;
        case "attribute_not_exists(PK)":
          allowed = !old;
          break;
        case "#version = :expectedVersion":
          allowed = old?.version === values[":expectedVersion"];
          break;
        case "attribute_not_exists(PK) OR #expires <= :now":
          allowed = !old || (typeof old.expiresAt === "number" && old.expiresAt <= values[":now"]);
          break;
        default:
          throw new Error("Unsupported workflow condition.");
      }
      return { Code: allowed ? "None" : "ConditionalCheckFailed" };
    });
    if (reasons.some((r) => r.Code !== "None"))
      throw Object.assign(new Error("private cancellation diagnostics"), {
        name:
          command instanceof PutItemCommand
            ? "ConditionalCheckFailedException"
            : "TransactionCanceledException",
        CancellationReasons: reasons,
      });
    const staged = structuredClone(this.items);
    writes.forEach((write, i) =>
      write.Put ? staged.set(keys[i]!, structuredClone(write.Put.Item!)) : staged.delete(keys[i]!),
    );
    this.items = staged;
    await this.after?.(command);
    return {};
  }
  get transactions() {
    return this.calls.filter(
      (call): call is TransactWriteItemsCommand => call instanceof TransactWriteItemsCommand,
    );
  }
  decoded(kind?: string) {
    return [...this.items.values()]
      .map((item) => unmarshall(item))
      .filter((row) => !kind || row.itemKind === kind);
  }
}
