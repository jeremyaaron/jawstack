import type { JawStackAuthState } from "@jawstack/angular";

export function demoAuthState(): JawStackAuthState {
  return {
    subject: "demo_user",
    displayName: "Demo User",
    roles: ["user", "manager"],
  };
}
