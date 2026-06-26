import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  JawStackDefinitionError,
  type AuthContext,
  type CommandCommitInput,
  type ResourceState,
  defineCommand,
  defineDetailView,
  defineListView,
  defineResource,
  defineSchedule,
  defineState,
  defineWorker,
  executeCommand,
  field,
  packageName,
} from "../src/index";

type WorkRequestState = {
  title: string;
  status: "open" | "closed";
};

const auth: AuthContext = {
  subject: "user_123",
  displayName: "Jeremy",
  roles: ["user", "manager"],
  claims: {},
  mode: "test",
};

const fixedIds = {
  requestId: () => "req_123",
  correlationId: () => "corr_123",
  resourceId: () => "wr_123",
  eventId: () => "evt_123",
  activityId: () => "act_123",
};

function createTestWorkRequestResource() {
  return defineResource({
    name: "workRequest",
    title: "Work Request",
    state: defineState({
      title: field.string({ required: true }),
      status: field.enum({ values: ["open", "closed"], defaultValue: "open" }),
    }),
    commands: {
      create: defineCommand({
        title: "Create Work Request",
        input: z.object({
          title: z.string().min(1),
        }),
        roles: ["user"],
        emits: [{ eventType: "workRequest.created", schemaVersion: 1 }],
        create: true,
        decide: ({ input }) => ({
          nextState: {
            title: input.title,
            status: "open",
          } satisfies WorkRequestState,
          activity: [{ activityType: "created", title: "Created work request" }],
          events: [
            {
              eventType: "workRequest.created",
              schemaVersion: 1,
              payload: { title: input.title },
            },
          ],
          response: { resourceId: "wr_123" },
        }),
      }),
      close: defineCommand({
        title: "Close Work Request",
        input: z.object({}),
        roles: ["manager"],
        emits: [{ eventType: "workRequest.closed", schemaVersion: 1 }],
        decide: ({ previous }) => ({
          nextState: {
            ...(previous?.state as WorkRequestState),
            status: "closed",
          } satisfies WorkRequestState,
          activity: [{ activityType: "closed", title: "Closed work request" }],
          events: [
            {
              eventType: "workRequest.closed",
              schemaVersion: 1,
              payload: {},
            },
          ],
          response: { closed: true },
        }),
      }),
    },
  });
}

function createRepository(state?: ResourceState<WorkRequestState>) {
  return {
    getState: async () => state,
  };
}

function createUnitOfWork() {
  const commits: CommandCommitInput[] = [];

  return {
    commits,
    unitOfWork: {
      commit: async (input: CommandCommitInput) => {
        commits.push(input);
      },
    },
  };
}

function noOpDecision(eventType: string) {
  return {
    nextState: {},
    activity: [{ activityType: "changed", title: "Changed" }],
    events: [{ eventType, schemaVersion: 1, payload: {} }],
    response: {},
  };
}

describe("@jawstack/core metadata API", () => {
  it("exports the package name", () => {
    expect(packageName).toBe("@jawstack/core");
  });

  it("defines a WorkRequest resource", () => {
    const workRequestState = defineState({
      title: field.string({ required: true, label: "Title" }),
      description: field.text({ label: "Description" }),
      status: field.enum({
        label: "Status",
        values: ["open", "inReview", "blocked", "closed"],
        defaultValue: "open",
      }),
      assigneeId: field.string({ label: "Assignee" }),
      updatedAt: field.datetime({ label: "Updated" }),
    });

    const createWorkRequest = defineCommand({
      title: "Create Work Request",
      input: z.object({ title: z.string().min(1) }),
      roles: ["user"],
      emits: [{ eventType: "workRequest.created", schemaVersion: 1 }],
      create: true,
      decide: () => noOpDecision("workRequest.created"),
    });

    const assignWorkRequest = defineCommand({
      title: "Assign",
      input: z.object({ assigneeId: z.string().min(1) }),
      roles: ["manager"],
      emits: [{ eventType: "workRequest.assigned", schemaVersion: 1 }],
      decide: () => noOpDecision("workRequest.assigned"),
    });

    const resource = defineResource({
      name: "workRequest",
      title: "Work Request",
      state: workRequestState,
      commands: {
        create: createWorkRequest,
        assign: assignWorkRequest,
      },
      views: {
        list: defineListView({
          title: "Work Requests",
          columns: ["title", "status", "assigneeId", "updatedAt"],
        }),
        detail: defineDetailView({
          titleField: "title",
          sections: ["summary", "activity", "comments"],
        }),
      },
      workers: [
        defineWorker({
          name: "sendNotification",
          eventTypes: ["workRequest.created"],
          maxConcurrency: 2,
          handler: () => undefined,
        }),
      ],
      schedules: [
        defineSchedule({
          name: "staleReminder",
          expression: "rate(1 day)",
          targetHandler: "findStaleOpenRequests",
        }),
      ],
    });

    expect(resource.kind).toBe("jawstack.resource");
    expect(resource.name).toBe("workRequest");
    expect(resource.state.fields.status.kind).toBe("enum");
    expect(resource.commands.create.create).toBe(true);
    expect(resource.commands.assign.emits[0]?.eventType).toBe("workRequest.assigned");
    expect(resource.views.list?.columns).toEqual(["title", "status", "assigneeId", "updatedAt"]);
    expect(resource.workers[0]?.maxConcurrency).toBe(2);
    expect(resource.schedules[0]?.expression).toBe("rate(1 day)");
    expect(Object.isFrozen(resource)).toBe(true);
    expect(Object.isFrozen(resource.state.fields.status)).toBe(true);
  });

  it("rejects invalid resource names", () => {
    expect(() =>
      defineResource({
        name: "WorkRequest",
        title: "Work Request",
        state: defineState({ title: field.string() }),
        commands: {
          create: defineCommand({
            title: "Create",
            input: z.object({}),
            roles: ["user"],
            emits: [{ eventType: "workRequest.created", schemaVersion: 1 }],
            create: true,
            decide: () => noOpDecision("workRequest.created"),
          }),
        },
      }),
    ).toThrow(JawStackDefinitionError);
  });

  it("rejects invalid enum defaults", () => {
    const values: readonly string[] = ["open", "closed"];

    expect(() =>
      field.enum({
        values,
        defaultValue: "blocked",
      }),
    ).toThrow(JawStackDefinitionError);
  });

  it("rejects commands without roles", () => {
    expect(() =>
      defineCommand({
        title: "Create",
        input: z.object({}),
        roles: [],
        emits: [{ eventType: "workRequest.created", schemaVersion: 1 }],
        decide: () => noOpDecision("workRequest.created"),
      }),
    ).toThrow(JawStackDefinitionError);
  });

  it("rejects commands without event schema versions", () => {
    expect(() =>
      defineCommand({
        title: "Create",
        input: z.object({}),
        roles: ["user"],
        emits: [{ eventType: "workRequest.created", schemaVersion: 0 }],
        decide: () => noOpDecision("workRequest.created"),
      }),
    ).toThrow(JawStackDefinitionError);
  });

  it("rejects list views that reference unknown state fields", () => {
    expect(() =>
      defineResource({
        name: "workRequest",
        title: "Work Request",
        state: defineState({ title: field.string() }),
        commands: {
          create: defineCommand({
            title: "Create",
            input: z.object({}),
            roles: ["user"],
            emits: [{ eventType: "workRequest.created", schemaVersion: 1 }],
            create: true,
            decide: () => noOpDecision("workRequest.created"),
          }),
        },
        views: {
          list: defineListView({ columns: ["missingField"] }),
        },
      }),
    ).toThrow(JawStackDefinitionError);
  });
});

describe("@jawstack/core command executor", () => {
  it("executes a create command and commits state, activity, and outbox events", async () => {
    const { commits, unitOfWork } = createUnitOfWork();

    const result = await executeCommand(
      {
        resourceType: "workRequest",
        commandName: "create",
        input: { title: "Write tests" },
        requestContext: {},
      },
      {
        registry: [createTestWorkRequestResource()],
        repository: createRepository(),
        unitOfWork,
        authProvider: { resolve: () => auth },
        ids: fixedIds,
        clock: () => new Date("2026-06-25T12:00:00.000Z"),
        source: "jawstack.test",
      },
    );

    expect(result.ok).toBe(true);
    expect(result.ok && result.data).toEqual({ resourceId: "wr_123" });
    expect(commits).toHaveLength(1);
    expect(commits[0]?.resource.create).toBe(true);
    expect(commits[0]?.resource.next.version).toBe(1);
    expect(commits[0]?.activity[0]?.activityId).toBe("act_123");
    expect(commits[0]?.outbox[0]).toMatchObject({
      eventId: "evt_123",
      eventType: "workRequest.created",
      source: "jawstack.test",
      resourceId: "wr_123",
      correlationId: "corr_123",
      causationId: "req_123",
      payload: { title: "Write tests" },
    });
  });

  it("executes an update command against existing state", async () => {
    const { commits, unitOfWork } = createUnitOfWork();

    const previous: ResourceState<WorkRequestState> = {
      resourceType: "workRequest",
      resourceId: "wr_123",
      version: 3,
      state: { title: "Write tests", status: "open" },
      createdAt: "2026-06-24T12:00:00.000Z",
      updatedAt: "2026-06-24T12:00:00.000Z",
      createdBy: "user_123",
      updatedBy: "user_123",
    };

    const result = await executeCommand(
      {
        resourceType: "workRequest",
        resourceId: "wr_123",
        commandName: "close",
        input: {},
        requestContext: {},
      },
      {
        registry: [createTestWorkRequestResource()],
        repository: createRepository(previous),
        unitOfWork,
        authProvider: { resolve: () => auth },
        ids: fixedIds,
        clock: () => new Date("2026-06-25T12:00:00.000Z"),
      },
    );

    expect(result.ok).toBe(true);
    expect(commits[0]?.resource.create).toBe(false);
    expect(commits[0]?.resource.expectedVersion).toBe(3);
    expect(commits[0]?.resource.next.version).toBe(4);
    expect(commits[0]?.resource.next.state).toEqual({ title: "Write tests", status: "closed" });
  });

  it("returns validation errors without committing", async () => {
    const { commits, unitOfWork } = createUnitOfWork();

    const result = await executeCommand(
      {
        resourceType: "workRequest",
        commandName: "create",
        input: { title: "" },
        requestContext: {},
      },
      {
        registry: [createTestWorkRequestResource()],
        repository: createRepository(),
        unitOfWork,
        authProvider: { resolve: () => auth },
        ids: fixedIds,
      },
    );

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe("command.validation");
    expect(commits).toHaveLength(0);
  });

  it("returns forbidden errors without committing", async () => {
    const { commits, unitOfWork } = createUnitOfWork();

    const result = await executeCommand(
      {
        resourceType: "workRequest",
        resourceId: "wr_123",
        commandName: "close",
        input: {},
        requestContext: {},
      },
      {
        registry: [createTestWorkRequestResource()],
        repository: createRepository(),
        unitOfWork,
        authProvider: {
          resolve: () => ({
            ...auth,
            roles: ["user"],
          }),
        },
        ids: fixedIds,
      },
    );

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe("auth.forbidden");
    expect(commits).toHaveLength(0);
  });

  it("returns missing resource errors without committing", async () => {
    const { commits, unitOfWork } = createUnitOfWork();

    const result = await executeCommand(
      {
        resourceType: "workRequest",
        resourceId: "wr_missing",
        commandName: "close",
        input: {},
        requestContext: {},
      },
      {
        registry: [createTestWorkRequestResource()],
        repository: createRepository(),
        unitOfWork,
        authProvider: { resolve: () => auth },
        ids: fixedIds,
      },
    );

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe("resource.not_found");
    expect(commits).toHaveLength(0);
  });
});
