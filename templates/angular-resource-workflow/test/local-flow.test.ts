import type { ActivityRecord, ProjectionRecord, ResourceState } from "@jawstack/core";
import { describe, expect, it } from "vitest";

import { startDemoApiServer } from "../src/api";

type ApiSuccess<T> = Readonly<{
  ok: true;
  data: T;
}>;

type CommandRequest<TInput> = Readonly<{
  resourceType: string;
  resourceId?: string;
  commandName: string;
  input: TInput;
}>;

describe("demo Work Requests local flow", () => {
  it("creates, lists, reads, comments, and closes a work request through the local API", async () => {
    const api = await startDemoApiServer({
      port: 0,
      silent: true,
      ids: {
        resourceId: () => "wr_demo",
        requestId: () => "req_demo",
        correlationId: () => "corr_demo",
        eventId: () => "evt_demo",
        activityId: () => "act_demo",
      },
    });

    try {
      const baseUrl = `${api.baseUrl}/api`;
      const created = await command<{ title: string; description: string }, CommandResult>(
        baseUrl,
        {
          resourceType: "workRequest",
          commandName: "create",
          input: {
            title: "Demo request",
            description: "Exercise the local app flow.",
          },
        },
      );

      await command<{ body: string }, CommandResult>(baseUrl, {
        resourceType: "workRequest",
        resourceId: created.resourceId,
        commandName: "comment",
        input: {
          body: "Looks reproducible.",
        },
      });
      await command<{ reason: string }, CommandResult>(baseUrl, {
        resourceType: "workRequest",
        resourceId: created.resourceId,
        commandName: "close",
        input: {
          reason: "Resolved locally.",
        },
      });

      const detail = await getJson<ResourceState<Record<string, unknown>>>(
        `${baseUrl}/resources/workRequest/${created.resourceId}`,
      );
      const list = await getJson<{ items: readonly ProjectionRecord[] }>(
        `${baseUrl}/resources/workRequest`,
      );
      const activity = await getJson<{ items: readonly ActivityRecord[] }>(
        `${baseUrl}/resources/workRequest/${created.resourceId}/activity`,
      );

      expect(created).toEqual({
        resourceId: "wr_demo",
        status: "open",
      });
      expect(detail.state).toMatchObject({
        title: "Demo request",
        status: "closed",
      });
      expect(list.items).toHaveLength(1);
      expect(list.items[0]?.data).toMatchObject({
        resourceId: "wr_demo",
        title: "Demo request",
        status: "closed",
      });
      expect(activity.items.map((item) => item.activityType)).toEqual([
        "created",
        "commentAdded",
        "closed",
      ]);
    } finally {
      await api.close();
    }
  });

  it("rejects local API commands without demo auth headers", async () => {
    const api = await startDemoApiServer({
      port: 0,
      silent: true,
    });

    try {
      const response = await fetch(`${api.baseUrl}/api/resources/workRequest/commands/create`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          input: {
            title: "No auth",
          },
        }),
      });
      const body = (await response.json()) as { ok: false; error: { code: string } };

      expect(response.status).toBe(401);
      expect(body.error.code).toBe("auth.missing");
    } finally {
      await api.close();
    }
  });
});

type CommandResult = Readonly<{
  resourceId: string;
  status: string;
}>;

async function command<TInput, TOutput>(
  baseUrl: string,
  request: CommandRequest<TInput>,
): Promise<TOutput> {
  const url =
    request.resourceId === undefined
      ? `${baseUrl}/resources/${request.resourceType}/commands/${request.commandName}`
      : `${baseUrl}/resources/${request.resourceType}/${request.resourceId}/commands/${request.commandName}`;

  return postJson<TOutput>(url, { input: request.input });
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: demoAuthHeaders(),
  });
  return successData<T>(response);
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      ...demoAuthHeaders(),
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return successData<T>(response);
}

async function successData<T>(response: Response): Promise<T> {
  const body = (await response.json()) as ApiSuccess<T>;

  if (!response.ok || body.ok !== true) {
    throw new Error(`Expected successful API response from ${response.url}.`);
  }

  return body.data;
}

function demoAuthHeaders(): Record<string, string> {
  return {
    "x-jawstack-subject": "demo_user",
    "x-jawstack-display-name": "Demo User",
    "x-jawstack-roles": "user,manager",
  };
}
