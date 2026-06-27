import type { Routes } from "@angular/router";

import {
  NewWorkRequestPageComponent,
  WorkRequestDetailPageComponent,
  WorkRequestListPageComponent,
} from "./work-request.pages";

export const routes: Routes = [
  {
    path: "",
    pathMatch: "full",
    redirectTo: "work-requests",
  },
  {
    path: "work-requests",
    component: WorkRequestListPageComponent,
  },
  {
    path: "work-requests/new",
    component: NewWorkRequestPageComponent,
  },
  {
    path: "work-requests/:id",
    component: WorkRequestDetailPageComponent,
  },
];
