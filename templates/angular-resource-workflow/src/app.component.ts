import { Component } from "@angular/core";
import { RouterOutlet } from "@angular/router";
import { JsAppShellComponent, type JawStackNavItem } from "@jawstack/angular";

@Component({
  selector: "jawstack-app",
  standalone: true,
  imports: [RouterOutlet, JsAppShellComponent],
  template: `
    <js-app-shell title="Work Requests" [navItems]="navItems">
      <router-outlet></router-outlet>
    </js-app-shell>
  `,
})
export class DemoWorkRequestsAppComponent {
  readonly navItems: readonly JawStackNavItem[] = [
    {
      label: "Work Requests",
      href: "/work-requests",
    },
  ];
}
