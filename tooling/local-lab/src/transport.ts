import { createLocalAwsTransport } from "@jawstack/aws-runtime/local";

export function createLabTransport(): ReturnType<typeof createLocalAwsTransport> {
  return createLocalAwsTransport({ execution: { kind: "host" } });
}
