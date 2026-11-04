import { z } from "zod";
import { fixtures } from "./workflow";
import { serializeResult } from "./domain";
export class ReportClient {
  readonly url: string;
  constructor(
    url: string,
    readonly fixture = "requester_1",
  ) {
    const base = new URL(url);
    if (
      base.protocol !== "http:" ||
      base.hostname !== "127.0.0.1" ||
      !base.port ||
      base.username ||
      base.password ||
      base.pathname !== "/" ||
      base.search ||
      base.hash ||
      !fixtures.includes(fixture as (typeof fixtures)[number])
    )
      throw new Error("Invalid loopback API or fixture.");
    this.url = base.origin;
  }
  async request(path: string, body?: unknown, result = false) {
    const response = await fetch(this.url + path, {
      method: body === undefined ? "GET" : "POST",
      redirect: "error",
      headers: {
        "x-report-runs-fixture": this.fixture,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30000),
    });
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Missing API response.");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        size += item.value.byteLength;
        if (size > 512 * 1024) throw new Error("API response exceeds its bound.");
        chunks.push(item.value);
      }
    } finally {
      await reader.cancel();
    }
    const output = Buffer.concat(chunks);
    if (result && response.ok) {
      const stored = serializeResult(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(output)),
      );
      if (
        !stored.bytes.equals(output) ||
        response.headers.get("digest") !==
          "sha-256=" + Buffer.from(stored.digest, "hex").toString("base64")
      )
        throw new Error("API export verification failed.");
      return output;
    }
    const envelope = z
      .object({ ok: z.boolean(), error: z.object({ code: z.string() }).optional() })
      .parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(output)));
    if (!response.ok || !envelope.ok)
      throw new Error("Report API failed: " + (envelope.error?.code ?? response.status));
    return JSON.parse(output.toString("utf8")) as unknown;
  }
}
