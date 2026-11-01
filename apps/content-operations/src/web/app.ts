import { Component, ElementRef, ViewChild, inject } from "@angular/core";
import { Router, NavigationEnd, RouterLink, RouterLinkActive, RouterOutlet } from "@angular/router";
import { takeUntilDestroyed } from "@angular/core/rxjs-interop";
import { filter } from "rxjs";
import { FormControl, ReactiveFormsModule } from "@angular/forms";
import {
  LucideFiles,
  LucideLayers,
  LucideClipboardCheck,
  LucideCalendarDays,
} from "@lucide/angular";
import { Workspace } from "./workspace";

@Component({
  selector: "content-operations",
  standalone: true,
  imports: [
    RouterLink,
    RouterLinkActive,
    RouterOutlet,
    LucideFiles,
    LucideLayers,
    LucideClipboardCheck,
    LucideCalendarDays,
    ReactiveFormsModule,
  ],
  template: `
    <a class="skip-link" href="#main">Skip to content</a>
    <div class="workspace">
      <aside class="sidebar">
        <a class="brand" routerLink="/content"
          ><svg lucideLayers aria-hidden="true"></svg
          ><span
            >Content<br />
            operations</span
          ></a
        >
        <p class="workspace-label">EDITORIAL WORKSPACE</p>
        <nav aria-label="Primary">
          <a routerLink="/content" routerLinkActive="active"
            ><svg lucideFiles aria-hidden="true"></svg>Content</a
          >
          <a routerLink="/reviews" routerLinkActive="active"
            ><svg lucideClipboardCheck aria-hidden="true"></svg>Reviews</a
          >
          <a routerLink="/calendar" routerLinkActive="active"
            ><svg lucideCalendarDays aria-hidden="true"></svg>Calendar</a
          >
        </nav>
        <div class="sidebar-footer">
          <span class="connection-dot"></span>{{ workspace.runtime()
          }}<span class="dev-label">DEV</span>
        </div>
      </aside>
      <div class="main-column">
        <header class="topbar">
          <span class="workspace-name">JawStack <span>/</span> Editorial</span
          ><label class="identity"
            >Identity<select aria-label="Fixture identity" [formControl]="identity">
              @for (identity of workspace.fixtures; track identity.subject) {
                <option [value]="identity.subject">
                  {{ identity.displayName }} · {{ identity.roles[0] }}
                </option>
              }
            </select></label
          >
        </header>
        <main id="main" #mainRegion tabindex="-1"><router-outlet /></main>
      </div>
    </div>
  `,
})
export class AppComponent {
  readonly workspace = inject(Workspace);
  readonly identity = new FormControl(this.workspace.fixture(), { nonNullable: true });
  @ViewChild("mainRegion") main?: ElementRef<HTMLElement>;
  constructor() {
    this.identity.valueChanges.pipe(takeUntilDestroyed()).subscribe((value) => {
      if (!this.workspace.changeFixture(value))
        this.identity.setValue(this.workspace.fixture(), { emitEvent: false });
    });
    void this.workspace.client
      .request<{ runtime: string; processing: string }>("/health")
      .then((health) =>
        this.workspace.runtime.set(health.runtime === "memory" ? "Memory" : "LocalStack"),
      )
      .catch(() => this.workspace.runtime.set("Offline"));
    let path = "";
    inject(Router)
      .events.pipe(
        filter((event) => event instanceof NavigationEnd),
        takeUntilDestroyed(),
      )
      .subscribe((event) => {
        const next = event.urlAfterRedirects.split("?")[0]!;
        if (next !== path) {
          path = next;
          queueMicrotask(() => this.main?.nativeElement.focus());
        }
      });
  }
}
