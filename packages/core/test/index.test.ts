import { describe, expect, it } from "vitest";

import {
  JawStackDefinitionError,
  defineCommand,
  defineDetailView,
  defineListView,
  defineResource,
  defineSchedule,
  defineState,
  defineWorker,
  field,
  packageName,
} from "../src/index";

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
      input: { type: "schema-placeholder" },
      roles: ["user"],
      emits: [{ eventType: "workRequest.created", schemaVersion: 1 }],
      create: true,
      decide: () => undefined,
    });

    const assignWorkRequest = defineCommand({
      title: "Assign",
      input: { type: "schema-placeholder" },
      roles: ["manager"],
      emits: [{ eventType: "workRequest.assigned", schemaVersion: 1 }],
      decide: () => undefined,
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
            input: {},
            roles: ["user"],
            emits: [{ eventType: "workRequest.created", schemaVersion: 1 }],
            create: true,
            decide: () => undefined,
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
        input: {},
        roles: [],
        emits: [{ eventType: "workRequest.created", schemaVersion: 1 }],
        decide: () => undefined,
      }),
    ).toThrow(JawStackDefinitionError);
  });

  it("rejects commands without event schema versions", () => {
    expect(() =>
      defineCommand({
        title: "Create",
        input: {},
        roles: ["user"],
        emits: [{ eventType: "workRequest.created", schemaVersion: 0 }],
        decide: () => undefined,
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
            input: {},
            roles: ["user"],
            emits: [{ eventType: "workRequest.created", schemaVersion: 1 }],
            create: true,
            decide: () => undefined,
          }),
        },
        views: {
          list: defineListView({ columns: ["missingField"] }),
        },
      }),
    ).toThrow(JawStackDefinitionError);
  });
});
