import type { ActivityRecord, ProjectionWrite } from "../index";
import { collectionName } from "./records";
import { component, instant, reject, utf8 } from "./validation";

export type WorkflowRecordKey = Readonly<{ partition: string; sort: string }>;
export type WorkflowCommandScope = Readonly<{
  resourceType: string;
  commandName: string;
  subject: string;
}>;

function key(partition: string, sort: string): WorkflowRecordKey {
  return Object.freeze({ partition: utf8(partition, 2048), sort: utf8(sort, 1024) });
}

// Backend-neutral identities preserve existing table formats without importing SDK shapes.
export const workflowRecordKeys = Object.freeze({
  resource: (resourceType: string, resourceId: string) =>
    key(`RES#${component(resourceType)}#${component(resourceId)}`, "STATE"),
  activity: (
    row: Pick<ActivityRecord, "resourceType" | "resourceId" | "occurredAt" | "activityId">,
  ) =>
    key(
      `RES#${component(row.resourceType)}#${component(row.resourceId)}`,
      `ACT#${instant(row.occurredAt)}#${component(row.activityId)}`,
    ),
  outbox: (eventId: string) => key(`OUTBOX#${component(eventId)}`, "EVENT"),
  idempotency: (scope: WorkflowCommandScope, idempotencyKey: string) =>
    key(
      `IDEMP#${component(scope.resourceType)}#${component(scope.commandName)}#${component(scope.subject)}`,
      component(idempotencyKey),
    ),
  projection: (
    resourceType: string,
    row: Pick<ProjectionWrite, "projectionName" | "itemId" | "sort">,
  ) => {
    component(resourceType);
    component(row.projectionName);
    component(row.itemId);
    const name = row.projectionName.startsWith(`${resourceType}.`)
      ? row.projectionName.slice(resourceType.length + 1)
      : row.projectionName;
    if (!name.split(".").every((segment) => /^[A-Za-z0-9_-]+$/.test(segment)))
      reject("Invalid workflow projection name segments.");
    const sort = utf8(row.sort, 1024);
    return key(
      `PROJ#${resourceType}#${name.replaceAll(".", "#")}`,
      sort.endsWith(`#${row.itemId}`) ? sort : `${sort}#${row.itemId}`,
    );
  },
  record: (collection: string, logicalKey: string) =>
    key(`OPS#${collectionName(collection)}`, logicalKey),
});
