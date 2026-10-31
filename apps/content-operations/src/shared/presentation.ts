import type { ResourceUiDefinition } from "@jawstack/angular";
import { assetVersionInput, registerAssetInput, assetStatuses } from "./assets";
import {
  approvalReferenceInput,
  publicationReferenceInput,
  rescheduleInput,
  scheduleInput,
  scheduleReferenceInput,
} from "./publication-inputs";
import {
  contentStatuses,
  createContentInput,
  editDraftInput,
  reviewDecisionInput,
  reviewStatuses,
  submitInput,
  versionInput,
} from "./contracts";

export const contentUi = {
  name: "contentItem",
  title: "Content Items",
  state: {
    kind: "jawstack.state",
    fields: {
      title: { kind: "string", required: true, label: "Title" },
      body: { kind: "text", required: true, label: "Body" },
      authorId: { kind: "string", required: true, label: "Author" },
      status: { kind: "enum", required: true, values: contentStatuses },
    },
  },
  views: {
    list: { kind: "jawstack.view.list", columns: ["title", "status", "authorId"] },
    detail: {
      kind: "jawstack.view.detail",
      titleField: "title",
      sections: ["editorial", "activity"],
    },
  },
  commands: {
    create: {
      title: "Create content",
      input: createContentInput,
      roles: ["author", "editor"],
      create: true,
    },
    editDraft: {
      title: "Save draft",
      input: editDraftInput,
      roles: ["author", "editor"],
      create: false,
    },
    submit: {
      title: "Submit for review",
      input: submitInput,
      roles: ["author", "editor"],
      create: false,
    },
    registerAsset: {
      title: "Register attachment",
      input: registerAssetInput,
      roles: ["author", "editor"],
      create: false,
    },
    removeAsset: {
      title: "Remove attachment",
      input: assetVersionInput,
      roles: ["author", "editor"],
      create: false,
    },
    approve: { title: "Approve", input: reviewDecisionInput, roles: ["editor"], create: false },
    requestChanges: {
      title: "Request changes",
      input: reviewDecisionInput,
      roles: ["editor"],
      create: false,
    },
    reopenDraft: {
      title: "Reopen draft",
      input: versionInput,
      roles: ["author", "editor"],
      create: false,
    },
    archive: { title: "Archive", input: versionInput, roles: ["editor"], create: false },
    schedule: { title: "Schedule", input: scheduleInput, roles: ["editor"], create: false },
    reschedule: { title: "Reschedule", input: rescheduleInput, roles: ["editor"], create: false },
    cancelSchedule: {
      title: "Cancel schedule",
      input: scheduleReferenceInput,
      roles: ["editor"],
      create: false,
    },
    publishNow: {
      title: "Publish now",
      input: approvalReferenceInput,
      roles: ["editor"],
      create: false,
    },
    retryPublication: {
      title: "Retry publication",
      input: publicationReferenceInput,
      roles: ["editor"],
      create: false,
    },
  },
} satisfies ResourceUiDefinition;

export const assetUi = {
  name: "asset",
  title: "Assets",
  state: {
    kind: "jawstack.state",
    fields: {
      filename: { kind: "string", required: true, label: "Filename" },
      contentId: { kind: "string", required: true, label: "Content" },
      status: { kind: "enum", required: true, values: assetStatuses },
    },
  },
  views: {
    list: { kind: "jawstack.view.list", columns: ["filename", "status", "contentId"] },
    detail: { kind: "jawstack.view.detail", titleField: "filename", sections: ["metadata"] },
  },
  commands: {},
} satisfies ResourceUiDefinition;

export const reviewUi = {
  name: "reviewTask",
  title: "Review Tasks",
  state: {
    kind: "jawstack.state",
    fields: {
      contentId: { kind: "string", required: true, label: "Content" },
      status: { kind: "enum", required: true, values: reviewStatuses },
      assignedEditorId: { kind: "string", required: true, label: "Editor" },
      dueAt: { kind: "datetime", required: true, label: "Due" },
    },
  },
  views: {
    list: {
      kind: "jawstack.view.list",
      columns: ["contentId", "status", "assignedEditorId", "dueAt"],
    },
    detail: {
      kind: "jawstack.view.detail",
      titleField: "contentId",
      sections: ["snapshot", "decision"],
    },
  },
  commands: {},
} satisfies ResourceUiDefinition;
