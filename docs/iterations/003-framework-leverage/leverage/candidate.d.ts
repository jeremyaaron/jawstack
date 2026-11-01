declare module "leverage:candidate" {
  export function createApprovalHarness(
    backend: import("./contracts").Backend,
    fixture: typeof import("./contracts").fixture,
  ): Promise<import("./contracts").ApprovalHarness>;
  export function createPublicationHarness(
    backend: import("./contracts").Backend,
    fixture: typeof import("./contracts").fixture,
  ): Promise<import("./contracts").PublicationHarness>;
}
