// @vitest-environment jsdom
import "@angular/compiler";

import { provideZonelessChangeDetection } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import {
  BrowserDynamicTestingModule,
  platformBrowserDynamicTesting,
} from "@angular/platform-browser-dynamic/testing";
import {
  type ActivityRecord,
  type ProjectionRecord,
  type ResourceState,
  workRequestResource,
} from "@jawstack/core";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  JAWSTACK_API_CLIENT,
  JAWSTACK_AUTH,
  JsActivityTimelineComponent,
  JsCommandButtonComponent,
  JsCommandDialogComponent,
  JsResourceDetailComponent,
  JsResourceFormComponent,
  JsResourceListComponent,
  describePackage,
  packageName,
  type ExecuteCommandRequest,
  type JawStackApiClient,
} from "../src/index";

describe("@jawstack/angular", () => {
  beforeAll(() => {
    TestBed.initTestEnvironment(BrowserDynamicTestingModule, platformBrowserDynamicTesting());
  });

  afterEach(() => {
    TestBed.resetTestingModule();
  });

  it("exports package metadata", () => {
    expect(packageName).toBe("@jawstack/angular");
    expect(describePackage()).toContain("standalone resource workflow components");
  });

  it("renders a Work Request list from metadata and uses the API client", async () => {
    const api = new MockJawStackApiClient({
      listItems: [
        projection({
          itemId: "wr_123",
          data: {
            title: "Fix checkout",
            status: "open",
            assigneeId: "user_123",
            updatedAt: "2026-06-25T12:00:00.000Z",
          },
        }),
      ],
    });
    const fixture = TestBed.configureTestingModule({
      imports: [JsResourceListComponent],
      providers: [
        provideZonelessChangeDetection(),
        { provide: JAWSTACK_API_CLIENT, useValue: api },
      ],
    }).createComponent(JsResourceListComponent);

    fixture.componentInstance.resource = workRequestResource;
    await fixture.componentInstance.load();
    fixture.detectChanges();

    expect(api.list).toHaveBeenCalledWith("workRequest", { viewName: "list" });
    expect(fixture.nativeElement.textContent).toContain("Work Request");
    expect(fixture.nativeElement.textContent).toContain("Fix checkout");
    expect(fixture.nativeElement.textContent).toContain("Open");
  });

  it("renders list error states", async () => {
    const api = new MockJawStackApiClient({
      listError: new Error("List failed"),
    });
    const fixture = TestBed.configureTestingModule({
      imports: [JsResourceListComponent],
      providers: [
        provideZonelessChangeDetection(),
        { provide: JAWSTACK_API_CLIENT, useValue: api },
      ],
    }).createComponent(JsResourceListComponent);

    fixture.componentInstance.resource = workRequestResource;
    await fixture.componentInstance.load();
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain("List failed");
  });

  it("renders detail and activity data through API abstractions", async () => {
    const api = new MockJawStackApiClient({
      detail: resourceState(),
      activityItems: [activityRecord()],
    });
    const fixture = TestBed.configureTestingModule({
      imports: [JsResourceDetailComponent],
      providers: [
        provideZonelessChangeDetection(),
        { provide: JAWSTACK_API_CLIENT, useValue: api },
      ],
    }).createComponent(JsResourceDetailComponent);

    fixture.componentInstance.resource = workRequestResource;
    fixture.componentInstance.resourceId = "wr_123";
    await fixture.componentInstance.load();
    fixture.detectChanges();

    expect(api.get).toHaveBeenCalledWith("workRequest", "wr_123");
    expect(fixture.nativeElement.textContent).toContain("Fix checkout");
  });

  it("renders the activity timeline empty state", async () => {
    const api = new MockJawStackApiClient({
      activityItems: [],
    });
    const fixture = TestBed.configureTestingModule({
      imports: [JsActivityTimelineComponent],
      providers: [
        provideZonelessChangeDetection(),
        { provide: JAWSTACK_API_CLIENT, useValue: api },
      ],
    }).createComponent(JsActivityTimelineComponent);

    fixture.componentInstance.resource = workRequestResource;
    fixture.componentInstance.resourceId = "wr_123";
    await fixture.componentInstance.load();
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain("No activity");
  });

  it("emits parsed command input from resource forms", async () => {
    const fixture = TestBed.configureTestingModule({
      imports: [JsResourceFormComponent],
      providers: [provideZonelessChangeDetection()],
    }).createComponent(JsResourceFormComponent);
    const submitted = vi.fn();

    fixture.componentInstance.resource = workRequestResource;
    fixture.componentInstance.commandName = "create";
    fixture.componentInstance.submitted.subscribe(submitted);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector("input#title")).not.toBeNull();
    expect(fixture.nativeElement.querySelector("textarea#description")).not.toBeNull();
    const fields = fixture.componentInstance.fields;
    fixture.componentInstance.setValue(fields[0]!, "Fix checkout");
    fixture.componentInstance.setValue(fields[1]!, "Checkout cannot complete.");
    fixture.componentInstance.submit({ preventDefault: () => undefined } as Event);

    expect(submitted).toHaveBeenCalledWith({
      title: "Fix checkout",
      description: "Checkout cannot complete.",
    });
  });

  it("submits command dialog input through the API client", async () => {
    const api = new MockJawStackApiClient({
      commandResult: { resourceId: "wr_123" },
    });
    const fixture = TestBed.configureTestingModule({
      imports: [JsCommandDialogComponent],
      providers: [
        provideZonelessChangeDetection(),
        { provide: JAWSTACK_API_CLIENT, useValue: api },
      ],
    }).createComponent(JsCommandDialogComponent);

    fixture.componentInstance.resource = workRequestResource;
    fixture.componentInstance.commandName = "assign";
    fixture.componentInstance.resourceId = "wr_123";
    fixture.componentInstance.open = true;
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector("input#assigneeId")).not.toBeNull();
    await fixture.componentInstance.execute({ assigneeId: "user_456" });

    expect(api.commandMock).toHaveBeenCalledWith({
      resourceType: "workRequest",
      resourceId: "wr_123",
      commandName: "assign",
      input: {
        assigneeId: "user_456",
      },
    });
  });

  it("disables command buttons when the current user lacks required roles", () => {
    const fixture = TestBed.configureTestingModule({
      imports: [JsCommandButtonComponent],
      providers: [
        provideZonelessChangeDetection(),
        {
          provide: JAWSTACK_AUTH,
          useValue: () => ({
            subject: "user_123",
            roles: ["user"],
          }),
        },
      ],
    }).createComponent(JsCommandButtonComponent);

    fixture.componentRef.setInput("resource", workRequestResource);
    fixture.componentRef.setInput("commandName", "assign");
    fixture.detectChanges();

    const button = fixture.nativeElement.querySelector("button") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.textContent).toContain("Assign");
  });
});

class MockJawStackApiClient implements JawStackApiClient {
  readonly list = vi.fn(async () => {
    if (this.options.listError !== undefined) {
      throw this.options.listError;
    }

    return { items: this.options.listItems ?? [] };
  });

  readonly get = vi.fn(async () => this.options.detail ?? resourceState());
  readonly activity = vi.fn(async () => ({ items: this.options.activityItems ?? [] }));
  readonly commandMock = vi.fn(async (request: ExecuteCommandRequest) => {
    void request;
    return this.options.commandResult;
  });

  constructor(
    private readonly options: Readonly<{
      listItems?: readonly ProjectionRecord[];
      listError?: Error;
      detail?: ResourceState<Record<string, unknown>>;
      activityItems?: readonly ActivityRecord[];
      commandResult?: unknown;
    }> = {},
  ) {}

  async command<TInput, TOutput>(request: ExecuteCommandRequest<TInput>): Promise<TOutput> {
    return (await this.commandMock(request)) as TOutput;
  }
}

function projection(overrides: Partial<ProjectionRecord> = {}): ProjectionRecord {
  return {
    projectionName: "workRequest.list",
    itemId: "wr_123",
    sort: "001",
    data: {
      title: "Fix checkout",
      status: "open",
      assigneeId: "user_123",
      updatedAt: "2026-06-25T12:00:00.000Z",
    },
    ...overrides,
  };
}

function resourceState(): ResourceState<Record<string, unknown>> {
  return {
    resourceType: "workRequest",
    resourceId: "wr_123",
    version: 1,
    state: {
      title: "Fix checkout",
      description: "Checkout cannot complete.",
      status: "open",
      assigneeId: "user_123",
      updatedAt: "2026-06-25T12:00:00.000Z",
    },
    createdAt: "2026-06-25T12:00:00.000Z",
    updatedAt: "2026-06-25T12:00:00.000Z",
    createdBy: "user_123",
    updatedBy: "user_123",
  };
}

function activityRecord(): ActivityRecord {
  return {
    activityId: "act_123",
    resourceType: "workRequest",
    resourceId: "wr_123",
    activityType: "workRequest.created",
    title: "Created work request",
    correlationId: "corr_123",
    occurredAt: "2026-06-25T12:00:00.000Z",
  };
}
