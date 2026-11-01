import { Component, ElementRef, ViewChild, inject } from "@angular/core";
import { Router, NavigationEnd, RouterLink, RouterLinkActive, RouterOutlet } from "@angular/router";
import { takeUntilDestroyed } from "@angular/core/rxjs-interop";
import { filter } from "rxjs";
import { LucideFiles, LucideLayers } from "@lucide/angular";
import { Workspace } from "./workspace";

@Component({
  selector: "content-operations",
  standalone: true,
  imports: [RouterLink, RouterLinkActive, RouterOutlet, LucideFiles, LucideLayers],
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
            >Identity<select
              aria-label="Fixture identity"
              [value]="workspace.fixture()"
              (change)="changeFixture($event)"
            >
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
  @ViewChild("mainRegion") main?: ElementRef<HTMLElement>;
  constructor() {
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
  changeFixture(event: Event) {
    const select = event.target as HTMLSelectElement;
    if (!this.workspace.changeFixture(select.value)) select.value = this.workspace.fixture();
  }
}
