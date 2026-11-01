import { bootstrapApplication } from "@angular/platform-browser";
import { provideRouter } from "@angular/router";
import { inject } from "@angular/core";
import { provideJawStack, JAWSTACK_API_CLIENT, JAWSTACK_AUTH } from "@jawstack/angular";
import { AppComponent } from "./app";
import { ContentListComponent } from "./content-list";
import { ContentDetailComponent, draftGuard } from "./content-detail";
import { Workspace } from "./workspace";
import { contentUi, assetUi, reviewUi } from "../shared/presentation";
import "./styles.css";

bootstrapApplication(AppComponent, {
  providers: [
    provideRouter([
      { path: "", pathMatch: "full", redirectTo: "content" },
      { path: "content", component: ContentListComponent },
      { path: "content/new", component: ContentDetailComponent, canDeactivate: [draftGuard] },
      { path: "content/:id", component: ContentDetailComponent, canDeactivate: [draftGuard] },
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
