import { CommonModule } from "@angular/common";
import { Component, ViewChild, inject } from "@angular/core";
import { ActivatedRoute, Router } from "@angular/router";
import {
  JAWSTACK_API_CLIENT,
  JsActivityTimelineComponent,
  JsCommandButtonComponent,
  JsCommandDialogComponent,
  JsErrorPanelComponent,
  JsResourceDetailComponent,
  JsResourceFormComponent,
  JsResourceListComponent,
  type JawStackApiClient,
} from "@jawstack/angular";

import { demoWorkRequestResource } from "./example";

type CreateWorkRequestResult = Readonly<{
  resourceId: string;
}>;

@Component({
  selector: "demo-work-request-list-page",
  standalone: true,
  imports: [JsResourceListComponent],
  template: `
    <js-resource-list
      [resource]="resource"
      (selectResource)="openResource($event)"
      (createResource)="createResource()"
    ></js-resource-list>
  `,
})
export class WorkRequestListPageComponent {
  private readonly router = inject(Router);

  readonly resource = demoWorkRequestResource;

  openResource(resourceId: string): void {
    void this.router.navigate(["/work-requests", resourceId]);
  }

  createResource(): void {
    void this.router.navigate(["/work-requests/new"]);
  }
}

@Component({
  selector: "demo-new-work-request-page",
  standalone: true,
  imports: [CommonModule, JsErrorPanelComponent, JsResourceFormComponent],
  template: `
    <section class="demo-panel">
      <header>
        <h2>New Work Request</h2>
      </header>
      <js-error-panel *ngIf="error" [message]="error"></js-error-panel>
      <js-resource-form
        [resource]="resource"
        commandName="create"
        submitLabel="Create"
        (submitted)="create($event)"
        (cancelled)="cancel()"
      ></js-resource-form>
    </section>
  `,
  styles: [demoPanelStyles()],
})
export class NewWorkRequestPageComponent {
  private readonly api = inject<JawStackApiClient>(JAWSTACK_API_CLIENT);
  private readonly router = inject(Router);

  readonly resource = demoWorkRequestResource;
  error = "";

  async create(input: unknown): Promise<void> {
    this.error = "";

    try {
      const result = await this.api.command<unknown, CreateWorkRequestResult>({
        resourceType: this.resource.name,
        commandName: "create",
        input,
      });
      await this.router.navigate(["/work-requests", result.resourceId]);
    } catch (error) {
      this.error = error instanceof Error ? error.message : "Could not create work request.";
    }
  }

  cancel(): void {
    void this.router.navigate(["/work-requests"]);
  }
}

@Component({
  selector: "demo-work-request-detail-page",
  standalone: true,
  imports: [
    CommonModule,
    JsActivityTimelineComponent,
    JsCommandButtonComponent,
    JsCommandDialogComponent,
    JsResourceDetailComponent,
  ],
  template: `
    <section class="demo-detail">
      <div class="demo-toolbar">
        <button type="button" (click)="back()">Back</button>
        <js-command-button
          [resource]="resource"
          [resourceId]="resourceId"
          commandName="assign"
          (pressed)="openCommand('assign')"
        ></js-command-button>
        <js-command-button
          [resource]="resource"
          [resourceId]="resourceId"
          commandName="changeStatus"
          (pressed)="openCommand('changeStatus')"
        ></js-command-button>
        <js-command-button
          [resource]="resource"
          [resourceId]="resourceId"
          commandName="comment"
          (pressed)="openCommand('comment')"
        ></js-command-button>
        <js-command-button
          [resource]="resource"
          [resourceId]="resourceId"
          commandName="close"
          (pressed)="openCommand('close')"
        ></js-command-button>
      </div>
      <js-resource-detail
        #detail
        [resource]="resource"
        [resourceId]="resourceId"
      ></js-resource-detail>
      <js-activity-timeline
        #timeline
        [resource]="resource"
        [resourceId]="resourceId"
      ></js-activity-timeline>
      <js-command-dialog
        [resource]="resource"
        [resourceId]="resourceId"
        [commandName]="commandName"
        [open]="dialogOpen"
        (closed)="dialogOpen = false"
        (completed)="reload()"
      ></js-command-dialog>
    </section>
  `,
  styles: [
    `
      .demo-toolbar {
        align-items: center;
        display: flex;
        flex-wrap: wrap;
        gap: 0.5rem;
        margin-bottom: 1rem;
      }
    `,
  ],
})
export class WorkRequestDetailPageComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  @ViewChild("detail") private readonly detail?: JsResourceDetailComponent;
  @ViewChild("timeline") private readonly timeline?: JsActivityTimelineComponent;

  readonly resource = demoWorkRequestResource;
  readonly resourceId = this.route.snapshot.paramMap.get("id") ?? "";
  commandName = "comment";
  dialogOpen = false;

  back(): void {
    void this.router.navigate(["/work-requests"]);
  }

  openCommand(commandName: string): void {
    this.commandName = commandName;
    this.dialogOpen = true;
  }

  reload(): void {
    void this.detail?.load();
    void this.timeline?.load();
  }
}

function demoPanelStyles(): string {
  return `
    .demo-panel {
      max-width: 42rem;
    }
    .demo-panel header {
      margin-bottom: 1rem;
    }
    .demo-panel h2 {
      font-size: 1.125rem;
      margin: 0;
    }
  `;
}
