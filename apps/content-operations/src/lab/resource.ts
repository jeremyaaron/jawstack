import { defineCommand, defineResource, defineState, field } from "@jawstack/core";
import { z } from "zod";

export const proofResource = defineResource({
  name: "spineProof",
  title: "Transactional Spine Proof",
  state: defineState({ message: field.string({ required: true }) }),
  commands: {
    create: defineCommand({
      title: "Create proof",
      create: true,
      roles: ["lab"],
      input: z.object({ message: z.string().min(1).max(100) }).strict(),
      emits: [{ eventType: "spineProof.created", schemaVersion: 1 }],
      decide: ({ input, resourceId, now }) => ({
        nextState: input,
        activity: [{ activityType: "created", title: "Spine proof committed" }],
        events: [{ eventType: "spineProof.created", schemaVersion: 1, payload: input }],
        projections: [
          {
            projectionName: "spineProof.list",
            itemId: resourceId,
            sort: now.toISOString(),
            data: input,
          },
        ],
        response: { resourceId },
      }),
    }),
  },
});
