import { bootstrapApplication } from "@angular/platform-browser";
import { provideRouter, type CanDeactivateFn } from "@angular/router";
import { inject } from "@angular/core";
import { provideJawStack, JAWSTACK_API_CLIENT, JAWSTACK_AUTH } from "@jawstack/angular";
import { AppComponent } from "./app";
import { ContentListComponent } from "./content-list";
import { Workspace } from "./workspace";
import { contentUi, assetUi, reviewUi } from "../shared/presentation";
import "./styles.css";
const unsavedGuard: CanDeactivateFn<{ canLeave(): boolean }> = (component) => component.canLeave();

bootstrapApplication(AppComponent, {
  providers: [
    provideRouter([
      { path: "", pathMatch: "full", redirectTo: "content" },
      { path: "content", component: ContentListComponent },
      {
        path: "content/new",
        loadComponent: () =>
          import("./content-detail").then((module) => module.ContentDetailComponent),
        canDeactivate: [unsavedGuard],
      },
      {
        path: "content/:id",
        loadComponent: () =>
          import("./content-detail").then((module) => module.ContentDetailComponent),
        canDeactivate: [unsavedGuard],
      },
      {
        path: "operations",
        loadComponent: () => import("./operations").then((module) => module.OperationsComponent),
        canDeactivate: [unsavedGuard],
        runGuardsAndResolvers: "always",
      },
      {
        path: "calendar",
        loadComponent: () => import("./calendar").then((module) => module.CalendarComponent),
      },
      {
        path: "reviews",
        loadComponent: () => import("./review-list").then((module) => module.ReviewListComponent),
      },
      {
        path: "reviews/:id",
        loadComponent: () =>
          import("./review-detail").then((module) => module.ReviewDetailComponent),
        canDeactivate: [unsavedGuard],
      },
      { path: "**", redirectTo: "content" },
    ]),
    provideJawStack({ apiBaseUrl: "/api", resources: [contentUi, assetUi, reviewUi] }),
    { provide: JAWSTACK_API_CLIENT, useFactory: () => inject(Workspace).client },
    {
      provide: JAWSTACK_AUTH,
      useFactory: () => {
        const workspace = inject(Workspace);
        return () => workspace.fixtures.find((fixture) => fixture.subject === workspace.fixture());
      },
    },
  ],
}).catch(() => {
  document.querySelector("content-operations")!.textContent = "Content Operations could not start.";
});
