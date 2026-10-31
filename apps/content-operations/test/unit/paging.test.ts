import { describe, expect, it, vi } from "vitest";
import { createLabConfig } from "../../src/lab/config";
import { writePagingFixtures } from "../../src/lab/verify-paging";
import type { LabClients } from "../../src/lab/clients";

describe("paging fixture write bounds", () => {
  const config = createLabConfig();
  const item = { PutRequest: { Item: { PK: { S: "proof" }, SK: { S: "proof" } } } };
  it("splits writes at the 25-item service limit", async () => {
    const sizes: number[] = [];
    const send = vi.fn(async (command: { input: { RequestItems: Record<string, unknown[]> } }) => {
      sizes.push(command.input.RequestItems[config.table]!.length);
      return {};
    });
    await writePagingFixtures(
      { dynamo: { send } } as unknown as Pick<LabClients, "dynamo">,
      config,
      Array.from({ length: 51 }, () => item),
    );
    expect(send.mock.calls).toHaveLength(3);
    expect(sizes).toEqual([25, 25, 1]);
  });
  it("stops after three attempts when unprocessed items persist", async () => {
    const send = vi.fn(async () => ({ UnprocessedItems: { [config.table]: [item] } }));
    await expect(
      writePagingFixtures({ dynamo: { send } } as unknown as Pick<LabClients, "dynamo">, config, [
        item,
      ]),
    ).rejects.toThrow("retry budget");
    expect(send).toHaveBeenCalledTimes(3);
  });
  it("refuses an unexpected table in a batch response", async () => {
    const send = vi.fn(async () => ({ UnprocessedItems: { foreign: [item] } }));
    await expect(
      writePagingFixtures({ dynamo: { send } } as unknown as Pick<LabClients, "dynamo">, config, [
        item,
      ]),
    ).rejects.toThrow("Unexpected table");
    expect(send).toHaveBeenCalledTimes(1);
  });
});
