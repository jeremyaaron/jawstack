import { open, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { ReportClient } from "./client";
import { uuid } from "./domain";
import { z } from "zod";
export async function runCli(args: string[], output: (data: string | Uint8Array) => void) {
  const command = args[0];
  const allowed: Record<string, string[]> = {
    request: ["input", "key"],
    status: ["id"],
    result: ["id", "output", "overwrite"],
    failures: ["consumer", "report", "limit", "cursor"],
    replay: ["failure", "request"],
  };
  if (!command || !allowed[command])
    throw new Error("Expected request, status, result, failures or replay.");
  const { values } = parseArgs({
    args: args.slice(1),
    strict: true,
    allowPositionals: false,
    options: Object.fromEntries(
      ["api", "fixture", ...allowed[command]!].map((name) => [
        name,
        { type: name === "overwrite" ? ("boolean" as const) : ("string" as const) },
      ]),
    ),
  });
  const required = (name: string) => {
    const value = values[name];
    if (typeof value !== "string" || !value) throw new Error("Missing --" + name);
    return value;
  };
  const client = new ReportClient(
    typeof values.api === "string" ? values.api : "http://127.0.0.1:4347",
    typeof values.fixture === "string" ? values.fixture : "requester_1",
  );
  let response: unknown;
  if (command === "request") {
    const path = required("input"),
      handle = await open(path, "r"),
      buffer = Buffer.alloc(20481);
    let size = 0;
    try {
      while (size < buffer.length) {
        const read = await handle.read(buffer, size, buffer.length - size, null);
        if (!read.bytesRead) break;
        size += read.bytesRead;
      }
    } finally {
      await handle.close();
    }
    if (size > 20480) throw new Error("Inventory file exceeds 20 KiB.");
    const file = buffer.subarray(0, size);
    response = await client.request("/api/reports", {
      input: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(file)),
      idempotencyKey: required("key"),
    });
  } else if (command === "status" || command === "result") {
    if (values.overwrite && !values.output) throw new Error("--overwrite requires --output.");
    const id = uuid.parse(required("id"));
    response = await client.request(
      "/api/reports/" + id + (command === "result" ? "/result" : ""),
      undefined,
      command === "result",
    );
    if (command === "result") {
      if (!Buffer.isBuffer(response)) throw new Error("Invalid result response.");
      if (typeof values.output === "string")
        await writeFile(values.output, response, {
          flag: values.overwrite ? "w" : "wx",
          mode: 0o600,
        });
      else output(response);
      return;
    }
  } else if (command === "failures") {
    const params = new URLSearchParams();
    if (values.consumer) params.set("consumer", required("consumer"));
    if (values.report) params.set("reportId", uuid.parse(required("report")));
    if (values.limit)
      params.set("limit", String(z.coerce.number().int().min(1).max(100).parse(values.limit)));
    if (values.cursor) params.set("cursor", required("cursor"));
    response = await client.request("/api/operations?" + params);
  } else {
    const id = z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .parse(required("failure"));
    response = await client.request("/api/operations/" + id + "/replay", {
      requestId: uuid.parse(required("request")),
    });
  }
  output(JSON.stringify(response) + "\n");
}
