import { z } from "zod";
import { JawStackRuntimeError, type AuthContext } from "../index";
import { component, freeze, jsonCopy } from "./validation";

const authSchema = z.strictObject({
  subject: z.string(),
  roles: z.array(z.string()),
  claims: z.record(z.string(), z.unknown()),
  mode: z.enum(["dev", "test", "external"]),
  displayName: z.string().max(200).optional(),
});

export function captureWorkflowIdentity(identity: AuthContext) {
  if ("tenantId" in identity)
    throw new JawStackRuntimeError(
      "auth.forbidden",
      "Tenant-scoped workflow commands are unsupported.",
    );
  const auth = jsonCopy(identity);
  if (!authSchema.safeParse(auth).success)
    throw new JawStackRuntimeError("auth.missing", "Invalid resolved workflow identity.");
  component(auth.subject);
  return freeze(auth);
}
