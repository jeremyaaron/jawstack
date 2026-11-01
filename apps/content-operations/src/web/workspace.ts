import { Injectable, signal } from "@angular/core";
import { fixtureIds, fixtureIdentities, type FixtureId } from "../shared/identities";
import { ContentOperationsClient } from "./client";

@Injectable({ providedIn: "root" })
export class Workspace {
  readonly fixtures = fixtureIdentities;
  readonly fixture = signal<FixtureId>(this.savedFixture());
  readonly client = new ContentOperationsClient({ fixture: () => this.fixture() });
  readonly runtime = signal("Connecting");
  listUrl = "/content";
  canLeave: () => boolean = () => true;
  changeFixture(value: string) {
    if (!fixtureIds.includes(value as FixtureId) || value === this.fixture() || !this.canLeave())
      return false;
    this.fixture.set(value as FixtureId);
    try {
      localStorage.setItem("content-ops-fixture", value);
    } catch {
      /* Storage can be disabled. */
    }
    return true;
  }
  private savedFixture(): FixtureId {
    try {
      const value = localStorage.getItem("content-ops-fixture");
      if (fixtureIds.includes(value as FixtureId)) return value as FixtureId;
    } catch {
      /* Storage can be disabled. */
    }
    return "author_1";
  }
}
