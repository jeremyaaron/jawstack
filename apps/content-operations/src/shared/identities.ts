import type { AuthContext } from "@jawstack/core";

export const fixtureIds = ["author_1", "author_2", "editor_1", "editor_2"] as const;
export const editorIds = ["editor_1", "editor_2"] as const;
export type FixtureId = (typeof fixtureIds)[number];
export const fixtureIdentities = Object.freeze(
  fixtureIds.map((subject) =>
    Object.freeze({
      subject,
      displayName: subject.replace("_", " "),
      roles: Object.freeze([subject.startsWith("editor") ? "editor" : "author"]),
    }),
  ),
);

export function fixtureAuth(subject: FixtureId): AuthContext {
  const fixture = fixtureIdentities.find((identity) => identity.subject === subject)!;
  return { ...fixture, claims: {}, mode: "test" };
}
