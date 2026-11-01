import { z } from "zod";
import type { ResourceUiDefinition } from "../../src/index";

export const createContentInput = z.object({
  title: z.string().min(1, "Title is required."),
  description: z.string().optional(),
});

export const contentUi = {
  name: "contentItem",
  title: "Content Items",
  state: {
    kind: "jawstack.state",
    fields: {
      title: { kind: "string", required: true, label: "Title" },
      description: { kind: "text", required: false, label: "Description" },
      status: { kind: "enum", required: true, values: ["draft", "approved"] },
    },
  },
  views: {
    list: { kind: "jawstack.view.list", columns: ["title", "status"] },
    detail: { kind: "jawstack.view.detail", titleField: "title", sections: ["details"] },
  },
  commands: {
    create: { title: "Create content", roles: ["author"], input: createContentInput, create: true },
    approve: {
      title: "Approve content",
      roles: ["editor"],
      create: false,
      input: z.object({ note: z.string().min(1, "Note is required.") }),
    },
  },
} satisfies ResourceUiDefinition;
