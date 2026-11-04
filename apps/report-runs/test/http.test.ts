import { describe, expect, it, vi } from "vitest";
import { request as nodeRequest } from "node:http";
import { connect } from "node:net";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { createMemoryReport } from "../src/workflow";
import { startReportApi } from "../src/server";
import { runCli } from "../src/cli";
import { createGatewayHandler } from "../src/lambda";
import { sha256 } from "../src/domain";
const input = { items: [{ itemId: "one", label: "Inventory", quantity: 12 }] };
async function harness(managed = false) {
  const workflow = createMemoryReport();
  const api = await startReportApi({ kind: "memory", workflow }, { port: 0, managed });
  const call = async (path: string, body?: unknown, identity = "requester_1") => {
    const response = await fetch(api.url + path, {
      method: body === undefined ? "GET" : "POST",
      redirect: "error",
      headers: {
        "x-report-runs-fixture": identity,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return {
      status: response.status,
      headers: response.headers,
      body: JSON.parse(await response.text()),
    };
  };
  return { workflow, api, call };
}
describe("loopback report HTTP and CLI", () => {
  it("reports dependency failures as sanitized 503 responses rather than invalid input", async () => {
    const workflow = createMemoryReport();
    const api = await startReportApi(
      {
        kind: "memory",
        workflow: {
          ...workflow,
          repository: {
            ...workflow.repository,
            getState: vi.fn().mockRejectedValue(new Error("private SDK endpoint and credentials")),
          },
        },
      },
      { port: 0, managed: false },
    );
    try {
      const response = await fetch(api.url + "/api/reports/20000000-0000-4000-8000-000000000001", {
        headers: { "x-report-runs-fixture": "requester_1" },
      });
      const body = await response.json();
      expect(response.status).toBe(503);
      expect(body).toMatchObject({
        ok: false,
        error: { code: "runtime.unavailable", message: "Report service unavailable." },
      });
      expect(JSON.stringify(body)).not.toMatch(/private|SDK|credentials/);
    } finally {
      await api.close();
    }
  });
  it("aborts an incomplete body during graceful close instead of waiting for its full deadline", async () => {
    const workflow = createMemoryReport(),
      api = await startReportApi({ kind: "memory", workflow }, { port: 0, managed: false });
    const socket = connect(Number(new URL(api.url).port), "127.0.0.1");
    const ready = new Promise<void>((resolve) => {
      socket.on("data", (b) => {
        if (String(b).includes("100 Continue")) resolve();
      });
    });
    const data = new Promise<string>((resolve) => {
      let text = "";
      socket.on("data", (b) => (text += String(b)));
      socket.once("close", () => resolve(text));
    });
    try {
      socket.write(
        "POST /api/reports HTTP/1.1\r\nHost: " +
          new URL(api.url).host +
          "\r\nx-report-runs-fixture: requester_1\r\nContent-Type: application/json\r\nExpect: 100-continue\r\nContent-Length: 20\r\n\r\n{",
      );
      await ready;
      await api.close();
      expect(await data).toContain("Request body deadline exceeded.");
      expect(workflow.store.resources.size).toBe(0);
    } finally {
      socket.destroy();
      await api.close();
    }
  });
  it("serves authoritative pending/completed results, pinned retries and requester boundaries", async () => {
    const h = await harness();
    try {
      const health = await h.call("/api/health");
      expect(health.body.data).toMatchObject({ runtime: "memory", processing: "manual" });
      const key = randomUUID(),
        created = await h.call("/api/reports", { input, idempotencyKey: key });
      expect(created.status).toBe(200);
      const id = created.body.data.reportId;
      expect((await h.call("/api/reports/" + id + "/result")).status).toBe(409);
      expect((await h.call("/api/reports/" + id, undefined, "requester_2")).status).toBe(403);
      expect((await h.call("/api/reports/" + id, undefined, "operator_1")).status).toBe(200);
      expect(
        (await h.call("/api/reports/" + id + "/commands/complete", {}, "operator_1")).status,
      ).toBe(404);
      await h.workflow.drainUntilIdle();
      const result = await fetch(h.api.url + "/api/reports/" + id + "/result", {
        headers: { "x-report-runs-fixture": "requester_1" },
      });
      const output = Buffer.from(await result.arrayBuffer());
      expect(result.status).toBe(200);
      const row = await h.call("/api/reports/" + id);
      expect(row.body.data.resource.version).toBe(2);
      expect(sha256(output)).toBe(row.body.data.resource.state.resultDigest);
      expect(output.toString().endsWith("\n")).toBe(true);
      expect(result.headers.get("cache-control")).toBe("private, no-store");
      expect((await h.call("/api/reports", { input, idempotencyKey: key })).body).toEqual(
        created.body,
      );
      expect((await h.call("/api/operations")).status).toBe(403);
      expect((await h.call("/api/operations?unknown=1", undefined, "operator_1")).status).toBe(400);
      expect((await h.call("/api/operations", undefined, "operator_1")).body.data.items).toEqual(
        [],
      );
      expect(
        (
          await h.call("/api/reports", {
            input,
            idempotencyKey: randomUUID(),
            requester: "operator_1",
          })
        ).status,
      ).toBe(400);
    } finally {
      await h.api.close();
    }
  });
  it("runs all CLI commands against the real API, with verified bytes and explicit non-overwriting exports", async () => {
    const h = await harness(true),
      directory = await mkdtemp(join(tmpdir(), "report-cli-"));
    const file = join(directory, "input.json"),
      out = join(directory, "result.json");
    await writeFile(file, JSON.stringify(input));
    const run = async (...args: string[]) => {
      const output: Buffer[] = [];
      await runCli([...args, "--api", h.api.url], (data) => output.push(Buffer.from(data)));
      return Buffer.concat(output);
    };
    try {
      const created = JSON.parse(
        (await run("request", "--input", file, "--key", "cli-key")).toString(),
      );
      const id = created.data.reportId;
      let state;
      for (let n = 0; n < 50; n++) {
        state = JSON.parse((await run("status", "--id", id)).toString());
        if (state.data.resource.state.status === "completed") break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(state.data.resource.state.status).toBe("completed");
      const child = await promisify(execFile)(
        process.execPath,
        ["--import", "tsx", "scripts/cli.ts", "status", "--id", id, "--api", h.api.url],
        { timeout: 10000 },
      );
      expect(JSON.parse(child.stdout).data.resource.version).toBe(2);
      await expect(
        promisify(execFile)(process.execPath, ["--import", "tsx", "scripts/cli.ts", "unknown"], {
          timeout: 10000,
        }),
      ).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('"code":"cli.failed"') });
      const bytes = await run("result", "--id", id);
      expect(JSON.parse(bytes.toString()).summary.totalQuantity).toBe(12);
      await run("result", "--id", id, "--output", out);
      expect(await readFile(out)).toEqual(bytes);
      await expect(run("result", "--id", id, "--output", out)).rejects.toThrow();
      await run("result", "--id", id, "--output", out, "--overwrite");
      expect(
        JSON.parse((await run("failures", "--fixture", "operator_1")).toString()).data.items,
      ).toEqual([]);
      await expect(run("failures")).rejects.toThrow();
      await expect(
        run(
          "replay",
          "--failure",
          "a".repeat(64),
          "--request",
          randomUUID(),
          "--fixture",
          "operator_1",
        ),
      ).rejects.toThrow();
      for (const args of [
        ["unknown"],
        ["status", "--id", id, "--bogus"],
        ["status", "--id", id, "--fixture", "report-worker"],
        ["status", "--id", id, "--api", "https://example.com"],
        ["request", "--input", file],
      ])
        await expect(runCli(args, () => {})).rejects.toThrow();
    } finally {
      await h.api.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("supports HTTP operations, immutable filters/cursors and targeted operator replay", async () => {
    let time = Date.now(),
      fail = true;
    const workflow = createMemoryReport({
      clock: () => new Date(time),
      hooks: {
        before: () => {
          if (fail) throw new Error("secret payload");
        },
      },
    });
    const api = await startReportApi({ kind: "memory", workflow }, { port: 0, managed: false });
    const call = async (path: string, body?: unknown, fixture = "operator_1") => {
      const r = await fetch(api.url + path, {
        method: body ? "POST" : "GET",
        headers: {
          "x-report-runs-fixture": fixture,
          "content-type": "application/json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return { status: r.status, data: JSON.parse(await r.text()) };
    };
    try {
      const ids = [];
      for (let n = 0; n < 3; n++)
        ids.push(
          (await call("/api/reports", { input, idempotencyKey: randomUUID() })).data.data.reportId,
        );
      await workflow.drain();
      time += 1000;
      await workflow.drain();
      time += 2000;
      await workflow.drain();
      const page = await call("/api/operations?limit=1");
      expect(page.data.data.items).toHaveLength(1);
      expect(JSON.stringify(page.data)).not.toContain("secret payload");
      const cursor = page.data.data.nextCursor;
      expect(
        (await call("/api/operations?limit=1&cursor=" + encodeURIComponent(cursor))).data.data
          .items,
      ).toHaveLength(1);
      expect(
        (await call("/api/operations?reportId=" + ids[0] + "&cursor=" + encodeURIComponent(cursor)))
          .status,
      ).toBe(400);
      const failure = page.data.data.items[0],
        key = randomUUID(),
        route = "/api/operations/" + failure.id + "/replay";
      expect((await call(route, { requestId: key }, "requester_1")).status).toBe(403);
      expect((await call(route, { requestId: key, event: {} })).status).toBe(400);
      fail = false;
      const replay = await call(route, { requestId: key });
      expect(replay.status).toBe(200);
      let cli = "";
      await runCli(
        [
          "replay",
          "--api",
          api.url,
          "--fixture",
          "operator_1",
          "--failure",
          failure.id,
          "--request",
          key,
        ],
        (data) => {
          cli += Buffer.from(data).toString();
        },
      );
      expect(JSON.parse(cli).data).toEqual(replay.data.data);
      expect((await call(route, { requestId: key })).data.data).toEqual(replay.data.data);
      await workflow.drainUntilIdle();
      expect(
        (await call("/api/reports/" + failure.resourceId)).data.data.resource.state.status,
      ).toBe("completed");
    } finally {
      await api.close();
    }
  });
  it("rejects unsafe origins, hosts, malformed UTF-8, oversized or compressed ingress without writes", async () => {
    const h = await harness();
    const raw = (headers: Record<string, string>, data: Buffer) =>
      new Promise<{ status: number; body: string }>((resolve) => {
        const r = nodeRequest(
          h.api.url + "/api/reports",
          {
            method: "POST",
            headers: {
              "x-report-runs-fixture": "requester_1",
              "content-type": "application/json",
              ...headers,
            },
          },
          (res) => {
            let text = "";
            res.on("data", (b) => (text += String(b)));
            res.on("end", () => resolve({ status: res.statusCode!, body: text }));
          },
        );
        r.end(data);
      });
    try {
      expect((await raw({ host: "evil.example" }, Buffer.from("{}"))).status).toBe(400);
      expect((await raw({ origin: "http://evil.example" }, Buffer.from("{}"))).status).toBe(400);
      expect((await raw({ "content-type": "text/plain" }, Buffer.from("{}"))).status).toBe(415);
      expect((await raw({ "content-encoding": "gzip" }, Buffer.from("{}"))).status).toBe(415);
      expect((await raw({}, Buffer.from([0xc0, 0x80]))).status).toBe(400);
      expect((await raw({}, Buffer.alloc(20481, 32))).status).toBe(413);
      expect(h.workflow.store.resources.size).toBe(0);
    } finally {
      await h.api.close();
    }
  });
  it("bounds body deadlines and admission and releases interrupted requests on close", async () => {
    const workflow = createMemoryReport(),
      api = await startReportApi(
        { kind: "memory", workflow },
        { port: 0, bodyTimeoutMs: 1000, maxInFlight: 1 },
      );
    const socket = connect(Number(new URL(api.url).port), "127.0.0.1");
    const ready = new Promise<void>((resolve) => {
      socket.on("data", (b) => {
        if (String(b).includes("100 Continue")) resolve();
      });
    });
    const data = new Promise<string>((resolve) => {
      let text = "";
      socket.on("data", (b) => (text += String(b)));
      socket.once("close", () => resolve(text));
    });
    try {
      socket.write(
        "POST /api/reports HTTP/1.1\r\nHost: " +
          new URL(api.url).host +
          "\r\nx-report-runs-fixture: requester_1\r\nContent-Type: application/json\r\nExpect: 100-continue\r\nContent-Length: 20\r\n\r\n{",
      );
      await ready;
      const r = await fetch(api.url + "/api/health");
      expect(r.status).toBe(503);
      expect(await data).toContain("Request body deadline exceeded.");
      expect(workflow.store.resources.size).toBe(0);
    } finally {
      socket.destroy();
      await api.close();
    }
  });
  it("relays the synthesis API to the same tested routes and never accepts public completion", async () => {
    const gateway = createGatewayHandler(async () => ({
      kind: "memory",
      workflow: createMemoryReport(),
    }));
    const response = await gateway({
      rawPath: "/api/reports",
      requestContext: { http: { method: "POST" } },
      headers: { "x-report-runs-fixture": "requester_1", "content-type": "application/json" },
      body: JSON.stringify({ input, idempotencyKey: "gateway" }),
    });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).data.status).toBe("requested");
  });
});
