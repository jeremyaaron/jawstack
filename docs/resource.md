# Resource

A resource is a domain object with state, commands, views, events, and optional jobs.

In the starter app, the canonical resource is `workRequest`.

## What A Resource Owns

A JawStack resource defines:

- Name and title.
- State fields.
- Commands.
- List and detail views.
- Event metadata emitted by commands.
- Optional workers.
- Optional schedules.

The resource definition is executable TypeScript metadata. It is consumed by local runtime routing, AWS runtime routing, Angular resource components, manifest generation, `jawstack doctor`, and CDK infrastructure.

## State

State is the current source of truth in v0.1. It is not event-sourced.

For Work Requests, state includes:

- `title`
- `description`
- `status`
- `assigneeId`
- `updatedAt`

AWS state is stored in DynamoDB as `RESOURCE_STATE` items. Activity, projections, idempotency records, and outbox events are separate item kinds in the same table.

## Views

The starter resource defines:

- A list view for operational scanning.
- A detail view for state, commands, comments, and activity.

List views read projection items. Detail views read current state and activity records.

## Generated Ownership

Generated app files are user-owned. You can edit resources, command decisions, UI pages, CDK composition, and styles. JawStack does not promise conflict-free regeneration for heavily edited apps in v0.1.
