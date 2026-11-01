import { GetItemCommand, QueryCommand, TransactWriteItemsCommand } from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import type { DynamoDbClientLike, DynamoDbItem } from "@jawstack/aws-runtime";

export const itemKey = (item: DynamoDbItem) => JSON.stringify([item.PK, item.SK]);
// Only the public command-builder protocol is supported; unexpected conditions fail closed.
export class TransactionClient implements DynamoDbClientLike {
  items = new Map<string, DynamoDbItem>();
  transactions: TransactWriteItemsCommand["input"][] = [];
  async send(command: { input: unknown }): Promise<unknown> {
    if (command instanceof GetItemCommand)
      return { Item: structuredClone(this.items.get(itemKey(command.input.Key!))) };
    if (command instanceof QueryCommand) {
      const values = unmarshall(command.input.ExpressionAttributeValues!);
      return {
        Items: [...this.items.values()]
          .filter(
            (item) =>
              item.PK?.S === values[":pk"] &&
              (!values[":skPrefix"] || item.SK!.S!.startsWith(values[":skPrefix"])),
          )
          .sort((a, b) => Buffer.compare(Buffer.from(a.SK!.S!), Buffer.from(b.SK!.S!))),
      };
    }
    if (!(command instanceof TransactWriteItemsCommand))
      throw new Error("Unexpected transaction SDK command.");
    this.transactions.push(structuredClone(command.input));
    const writes = command.input.TransactItems!;
    const keys = writes.map((write) => itemKey(write.Put?.Item ?? write.Delete!.Key!));
    if (new Set(keys).size !== keys.length) throw new Error("Duplicate physical action.");
    const reasons = writes.map((write, i) => {
      const put = write.Put;
      const current = this.items.get(keys[i]!);
      const old = current && unmarshall(current);
      const values = unmarshall(put?.ExpressionAttributeValues ?? {});
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
        case "attribute_not_exists(PK) OR expiresAt <= :now":
          allowed = !old || (typeof old.expiresAt === "number" && old.expiresAt <= values[":now"]);
          break;
        default:
          throw new Error("Unsupported transaction condition.");
      }
      return { Code: allowed ? "None" : "ConditionalCheckFailed" };
    });
    if (reasons.some((r) => r.Code !== "None"))
      throw Object.assign(new Error("Cancelled"), {
        name: "TransactionCanceledException",
        CancellationReasons: reasons,
      });
    const staged = structuredClone(this.items);
    writes.forEach((write, i) => {
      if (write.Put) staged.set(keys[i]!, structuredClone(write.Put.Item!));
      else staged.delete(keys[i]!);
    });
    this.items = staged;
    return {};
  }
}
