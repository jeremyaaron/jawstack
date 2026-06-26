import { bootstrapApplication } from "@angular/platform-browser";
import { provideRouter } from "@angular/router";
import { provideJawStack } from "@jawstack/angular";

import { DemoWorkRequestsAppComponent } from "./app.component";
import { demoAuthState } from "./auth";
import { demoResources } from "./example";
import { routes } from "./routes";
import "./styles.css";

bootstrapApplication(DemoWorkRequestsAppComponent, {
  providers: [
    provideRouter(routes),
    provideJawStack({
      apiBaseUrl: "/api",
      resources: demoResources,
      auth: demoAuthState,
    }),
  ],
}).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Angular bootstrap failed.";
  console.error(message);
});
