import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  InMemoryRepository,
  InMemoryStore,
  InMemoryUnitOfWork,
  JawStackDefinitionError,
  type AuthContext,
  type CommandCommitInput,
  type IdGenerator,
  type ResourceDefinition,
  type ResourceState,
  type WorkRequestState,
  createManifest,
  createResourceRegistry,
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
  serializeManifest,
  validateResourceRegistry,
  workRequestResource,
} from "../src/index";

type TestWorkRequestState = {
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
          } satisfies TestWorkRequestState,
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
            ...(previous?.state as TestWorkRequestState),
            status: "closed",
          } satisfies TestWorkRequestState,
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

function createRepository(state?: ResourceState<TestWorkRequestState>) {
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

function createSequenceIds(resourceId = "wr_flow"): Partial<IdGenerator> {
  let request = 0;
  let correlation = 0;
  let event = 0;
  let activity = 0;

  return {
    requestId: () => `req_${++request}`,
    correlationId: () => `corr_${++correlation}`,
    resourceId: () => resourceId,
    eventId: () => `evt_${++event}`,
    activityId: () => `act_${++activity}`,
  };
}

function createInMemoryWorkRequestRuntime(resourceId = "wr_flow") {
  const store = new InMemoryStore();
  const repository = new InMemoryRepository(store);
  const unitOfWork = new InMemoryUnitOfWork(store);

  return {
    store,
    repository,
    unitOfWork,
    options: {
      registry: [workRequestResource],
      repository,
      unitOfWork,
      authProvider: { resolve: () => auth },
      ids: createSequenceIds(resourceId),
      clock: () => new Date("2026-06-25T12:00:00.000Z"),
      source: "jawstack.test",
    },
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

    const previous: ResourceState<TestWorkRequestState> = {
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

describe("@jawstack/core in-memory Work Request runtime", () => {
  it("runs the full Work Request command flow with state, activity, outbox, and projections", async () => {
    const { repository, options } = createInMemoryWorkRequestRuntime();

    const created = await executeCommand<{ resourceId: string; status: string }>(
      {
        resourceType: "workRequest",
        commandName: "create",
        input: { title: "Replace intake form", description: "Current form is too slow." },
        idempotencyKey: "create-work-request",
        requestContext: {},
      },
      options,
    );

    expect(created.ok).toBe(true);
    const resourceId = created.ok ? created.data.resourceId : "";

    await executeCommand(
      {
        resourceType: "workRequest",
        resourceId,
        commandName: "assign",
        input: { assigneeId: "user_456" },
        requestContext: {},
      },
      options,
    );

    await executeCommand(
      {
        resourceType: "workRequest",
        resourceId,
        commandName: "changeStatus",
        input: { status: "inReview" },
        requestContext: {},
      },
      options,
    );

    const commented = await executeCommand<{ commentId: string }>(
      {
        resourceType: "workRequest",
        resourceId,
        commandName: "comment",
        input: { body: "I checked the workflow and it is ready to close." },
        requestContext: {},
      },
      options,
    );

    await executeCommand(
      {
        resourceType: "workRequest",
        resourceId,
        commandName: "close",
        input: { reason: "Completed" },
        requestContext: {},
      },
      options,
    );

    const stored = await repository.getState<WorkRequestState>("workRequest", resourceId);
    const activity = await repository.getActivity("workRequest", resourceId);
    const outbox = await repository.getOutbox();
    const projections = await repository.listProjection("workRequest.list");

    expect(stored?.version).toBe(5);
    expect(stored?.state).toMatchObject({
      title: "Replace intake form",
      description: "Current form is too slow.",
      status: "closed",
      assigneeId: "user_456",
    });
    expect(stored?.state.comments).toHaveLength(1);
    expect(stored?.state.comments[0]).toMatchObject({
      commentId: commented.ok ? commented.data.commentId : "",
      body: "I checked the workflow and it is ready to close.",
    });
    expect(activity.map((record) => record.activityType)).toEqual([
      "created",
      "assigned",
      "statusChanged",
      "commentAdded",
      "closed",
    ]);
    expect(outbox.map((event) => event.eventType)).toEqual([
      "workRequest.created",
      "workRequest.assigned",
      "workRequest.statusChanged",
      "workRequest.commentAdded",
      "workRequest.closed",
    ]);
    expect(projections).toHaveLength(1);
    expect(projections[0]?.data).toMatchObject({
      resourceId,
      title: "Replace intake form",
      status: "closed",
      assigneeId: "user_456",
    });
  });

  it("returns the stored response when an idempotency key is replayed with the same payload", async () => {
    const { repository, options } = createInMemoryWorkRequestRuntime("wr_idempotent");
    const request = {
      resourceType: "workRequest",
      commandName: "create",
      input: { title: "Replay safely" },
      idempotencyKey: "idem-create",
      requestContext: {},
    };

    const first = await executeCommand(request, options);
    const second = await executeCommand(request, options);
    const activity = await repository.getActivity("workRequest", "wr_idempotent");

    expect(second).toEqual(first);
    expect(activity).toHaveLength(1);
    expect(await repository.getState("workRequest", "wr_idempotent")).toBeDefined();
  });

  it("returns an idempotency conflict when a key is replayed with a different payload", async () => {
    const { options } = createInMemoryWorkRequestRuntime("wr_conflict");

    await executeCommand(
      {
        resourceType: "workRequest",
        commandName: "create",
        input: { title: "Original" },
        idempotencyKey: "idem-conflict",
        requestContext: {},
      },
      options,
    );

    const conflict = await executeCommand(
      {
        resourceType: "workRequest",
        commandName: "create",
        input: { title: "Different" },
        idempotencyKey: "idem-conflict",
        requestContext: {},
      },
      options,
    );

    expect(conflict.ok).toBe(false);
    expect(!conflict.ok && conflict.error.code).toBe("idempotency.conflict");
  });

  it("returns a structured conflict when an in-memory commit sees a stale version", async () => {
    const { repository, unitOfWork, options } = createInMemoryWorkRequestRuntime("wr_stale");

    await executeCommand(
      {
        resourceType: "workRequest",
        commandName: "create",
        input: { title: "Stale update" },
        requestContext: {},
      },
      options,
    );

    const stale = await repository.getState<WorkRequestState>("workRequest", "wr_stale");

    await executeCommand(
      {
        resourceType: "workRequest",
        resourceId: "wr_stale",
        commandName: "assign",
        input: { assigneeId: "user_456" },
        requestContext: {},
      },
      options,
    );

    const staleResult = await executeCommand(
      {
        resourceType: "workRequest",
        resourceId: "wr_stale",
        commandName: "close",
        input: {},
        requestContext: {},
      },
      {
        ...options,
        repository: {
          getState: async () => stale,
          getIdempotency: (key) => repository.getIdempotency(key),
        },
        unitOfWork,
      },
    );

    expect(staleResult.ok).toBe(false);
    expect(!staleResult.ok && staleResult.error.code).toBe("resource.conflict");
    expect(!staleResult.ok && staleResult.error.details).toEqual({
      expectedVersion: 1,
      actualVersion: 2,
    });
  });
});

describe("@jawstack/core registry and manifest", () => {
  it("creates a stable Work Request manifest without executable values", () => {
    const manifest = createManifest({
      appName: "work-requests",
      stage: "test",
      stable: true,
      resources: [workRequestResource],
      auth: {
        mode: "test",
        provider: "test",
      },
      costProfile: {
        lambda: {
          timeoutSeconds: 10,
          buildHook: () => "excluded",
        },
      },
    });

    const serialized = serializeManifest(manifest);

    expect(serialized).not.toContain("decide");
    expect(serialized).not.toContain("safeParse");
    expect(serialized).not.toContain("buildHook");
    expect(serialized).toMatchInlineSnapshot(`
      "{
        "appName": "work-requests",
        "auth": {
          "mode": "test",
          "provider": "test"
        },
        "costProfile": {
          "lambda": {
            "timeoutSeconds": 10
          }
        },
        "resources": [
          {
            "commands": [
              {
                "create": true,
                "emits": [
                  {
                    "eventType": "workRequest.created",
                    "schemaVersion": 1
                  }
                ],
                "name": "create",
                "roles": [
                  "user"
                ],
                "title": "Create Work Request"
              },
              {
                "create": false,
                "emits": [
                  {
                    "eventType": "workRequest.assigned",
                    "schemaVersion": 1
                  }
                ],
                "name": "assign",
                "roles": [
                  "manager"
                ],
                "title": "Assign"
              },
              {
                "create": false,
                "emits": [
                  {
                    "eventType": "workRequest.statusChanged",
                    "schemaVersion": 1
                  }
                ],
                "name": "changeStatus",
                "roles": [
                  "manager"
                ],
                "title": "Change Status"
              },
              {
                "create": false,
                "emits": [
                  {
                    "eventType": "workRequest.commentAdded",
                    "schemaVersion": 1
                  }
                ],
                "name": "comment",
                "roles": [
                  "user"
                ],
                "title": "Comment"
              },
              {
                "create": false,
                "emits": [
                  {
                    "eventType": "workRequest.closed",
                    "schemaVersion": 1
                  }
                ],
                "name": "close",
                "roles": [
                  "manager"
                ],
                "title": "Close"
              }
            ],
            "fields": [
              {
                "kind": "string",
                "label": "Title",
                "name": "title",
                "required": true
              },
              {
                "kind": "text",
                "label": "Description",
                "name": "description",
                "required": false
              },
              {
                "defaultValue": "open",
                "kind": "enum",
                "label": "Status",
                "name": "status",
                "required": false,
                "values": [
                  "open",
                  "inReview",
                  "blocked",
                  "closed"
                ]
              },
              {
                "kind": "string",
                "label": "Assignee",
                "name": "assigneeId",
                "required": false
              },
              {
                "kind": "datetime",
                "label": "Updated",
                "name": "updatedAt",
                "required": true
              }
            ],
            "name": "workRequest",
            "schedules": [],
            "title": "Work Request",
            "views": {
              "detail": {
                "kind": "jawstack.view.detail",
                "sections": [
                  "summary",
                  "activity",
                  "comments"
                ],
                "titleField": "title"
              },
              "list": {
                "columns": [
                  "title",
                  "status",
                  "assigneeId",
                  "updatedAt"
                ],
                "kind": "jawstack.view.list",
                "title": "Work Requests"
              }
            },
            "workers": []
          }
        ],
        "schemaVersion": 1,
        "stage": "test"
      }
      "
    `);
  });

  it("reports structured findings for duplicate and invalid registry definitions", () => {
    const malformed = {
      ...workRequestResource,
      name: "WorkRequest",
      state: {
        kind: "jawstack.state",
        fields: {
          title: field.string(),
        },
      },
      commands: {
        BadCommand: {
          ...workRequestResource.commands.create,
          input: {},
          roles: [],
          emits: [{ eventType: "created", schemaVersion: 0 }],
          decide: undefined,
        },
      },
      views: {
        list: defineListView({ columns: ["missing"] }),
        detail: defineDetailView({ titleField: "missing", sections: ["summary"] }),
      },
    } as unknown as ResourceDefinition;

    const result = validateResourceRegistry([workRequestResource, workRequestResource, malformed]);

    expect(result.findings.map((finding) => finding.id)).toEqual([
      "resource.name.duplicate",
      "resource.name.invalid",
      "command.name.invalid",
      "command.input.invalid",
      "command.handler.missing",
      "command.roles.empty",
      "event.type.invalid",
      "event.schema-version.missing",
      "view.list.column.unknown",
      "view.detail.title-field.unknown",
    ]);
    expect(result.findings[0]).toMatchObject({
      severity: "error",
      location: {
        path: "resources[1]",
        resource: "workRequest",
      },
    });
  });

  it("fails fast when creating a registry from invalid resources", () => {
    expect(() => createResourceRegistry([workRequestResource, workRequestResource])).toThrow(
      JawStackDefinitionError,
    );
  });

  it("includes generatedAt for non-stable manifests", () => {
    const manifest = createManifest({
      appName: "work-requests",
      stage: "dev",
      generatedAt: "2026-06-25T12:00:00.000Z",
      resources: [workRequestResource],
      auth: {
        mode: "dev",
        provider: "dev",
      },
      costProfile: {},
    });

    expect(manifest.generatedAt).toBe("2026-06-25T12:00:00.000Z");
  });
});
