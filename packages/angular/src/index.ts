import { CommonModule } from "@angular/common";
import {
  ChangeDetectorRef,
  Component,
  EventEmitter,
  InjectionToken,
  Input,
  Output,
  inject,
  makeEnvironmentProviders,
  type EnvironmentProviders,
} from "@angular/core";
import { FormsModule } from "@angular/forms";
import type {
  ActivityRecord,
  AuthContext,
  CommandDefinition,
  FieldDefinition,
  ProjectionRecord,
  ResourceDefinition,
  ResourceState,
} from "@jawstack/core";

export const packageName = "@jawstack/angular";

export function describePackage(): string {
  return `${packageName} standalone resource workflow components`;
}

export type JawStackNavItem = Readonly<{
  label: string;
  href: string;
}>;

export type JawStackAuthState = Pick<AuthContext, "subject" | "roles"> &
  Partial<Pick<AuthContext, "displayName" | "tenantId">>;

export type JawStackAuthProvider = () => JawStackAuthState | undefined;

export type ListOptions = Readonly<Record<string, unknown>>;

export type ResourceListResult = Readonly<{
  items: readonly ProjectionRecord[];
}>;

export type ResourceDetailResult = ResourceState;

export type ActivityResult = Readonly<{
  items: readonly ActivityRecord[];
}>;

export type ExecuteCommandRequest<TInput = unknown> = Readonly<{
  resourceType: string;
  resourceId?: string;
  commandName: string;
  input: TInput;
  idempotencyKey?: string;
}>;

export interface JawStackApiClient {
  list(resourceType: string, options?: ListOptions): Promise<ResourceListResult>;
  get(resourceType: string, resourceId: string): Promise<ResourceDetailResult>;
  activity(resourceType: string, resourceId: string): Promise<ActivityResult>;
  command<TInput, TOutput>(request: ExecuteCommandRequest<TInput>): Promise<TOutput>;
}

export type JawStackConfig = Readonly<{
  apiBaseUrl: string;
  resources: readonly ResourceDefinition[];
  auth?: JawStackAuthProvider;
  apiClient?: JawStackApiClient;
}>;

export const JAWSTACK_CONFIG = new InjectionToken<JawStackConfig>("JAWSTACK_CONFIG");
export const JAWSTACK_API_CLIENT = new InjectionToken<JawStackApiClient>("JAWSTACK_API_CLIENT");
export const JAWSTACK_AUTH = new InjectionToken<JawStackAuthProvider>("JAWSTACK_AUTH");

export function provideJawStack(config: JawStackConfig): EnvironmentProviders {
  return makeEnvironmentProviders([
    { provide: JAWSTACK_CONFIG, useValue: config },
    {
      provide: JAWSTACK_AUTH,
      useValue: config.auth ?? (() => undefined),
    },
    {
      provide: JAWSTACK_API_CLIENT,
      useFactory: () =>
        config.apiClient ??
        new FetchJawStackApiClient({
          apiBaseUrl: config.apiBaseUrl,
          ...(config.auth === undefined ? {} : { auth: config.auth }),
        }),
    },
  ]);
}

export class FetchJawStackApiClient implements JawStackApiClient {
  private readonly apiBaseUrl: string;
  private readonly auth: JawStackAuthProvider | undefined;

  constructor(options: Pick<JawStackConfig, "apiBaseUrl" | "auth">) {
    this.apiBaseUrl = options.apiBaseUrl.replace(/\/+$/u, "");
    this.auth = options.auth;
  }

  async list(resourceType: string): Promise<ResourceListResult> {
    return this.readSuccess<ResourceListResult>(`${this.apiBaseUrl}/resources/${resourceType}`);
  }

  async get(resourceType: string, resourceId: string): Promise<ResourceDetailResult> {
    return this.readSuccess<ResourceDetailResult>(
      `${this.apiBaseUrl}/resources/${resourceType}/${resourceId}`,
    );
  }

  async activity(resourceType: string, resourceId: string): Promise<ActivityResult> {
    return this.readSuccess<ActivityResult>(
      `${this.apiBaseUrl}/resources/${resourceType}/${resourceId}/activity`,
    );
  }

  async command<TInput, TOutput>(request: ExecuteCommandRequest<TInput>): Promise<TOutput> {
    const base = `${this.apiBaseUrl}/resources/${request.resourceType}`;
    const url =
      request.resourceId === undefined
        ? `${base}/commands/${request.commandName}`
        : `${base}/${request.resourceId}/commands/${request.commandName}`;
    return this.readSuccess<TOutput>(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        input: request.input,
        ...(request.idempotencyKey === undefined ? {} : { idempotencyKey: request.idempotencyKey }),
      }),
    });
  }

  private async readSuccess<T>(url: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(url, {
      ...init,
      headers: {
        ...authHeaders(this.auth?.()),
        ...init.headers,
      },
    });
    const body = (await response.json()) as { ok?: boolean; data?: T; error?: { message: string } };

    if (!response.ok || body.ok !== true) {
      throw new Error(body.error?.message ?? `JawStack API request failed: ${response.status}`);
    }

    return body.data as T;
  }
}

@Component({
  selector: "js-app-shell",
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="js-shell">
      <header class="js-shell__header">
        <strong class="js-shell__title">{{ title }}</strong>
        <nav class="js-shell__nav" aria-label="Primary">
          <a *ngFor="let item of navItems" [href]="item.href">{{ item.label }}</a>
        </nav>
      </header>
      <main class="js-shell__main">
        <ng-content></ng-content>
      </main>
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
        color: var(--js-color-text, #111827);
        font-family: var(--js-font-family, system-ui, sans-serif);
      }
      .js-shell__header {
        align-items: center;
        border-bottom: 1px solid var(--js-color-border, #d1d5db);
        display: flex;
        gap: 1rem;
        min-height: 3.5rem;
        padding: 0 1rem;
      }
      .js-shell__title {
        font-size: 1rem;
      }
      .js-shell__nav {
        display: flex;
        gap: 0.75rem;
      }
      .js-shell__nav a {
        color: var(--js-color-link, #2563eb);
        text-decoration: none;
      }
      .js-shell__main {
        padding: 1rem;
      }
    `,
  ],
})
export class JsAppShellComponent {
  @Input() title = "JawStack";
  @Input() navItems: readonly JawStackNavItem[] = [];
}

@Component({
  selector: "js-empty-state",
  standalone: true,
  imports: [CommonModule],
  template: `
    <section class="js-empty" role="status">
      <h2>{{ title }}</h2>
      <p>{{ message }}</p>
      <button *ngIf="actionLabel" type="button" (click)="action.emit()">{{ actionLabel }}</button>
    </section>
  `,
  styles: [panelStyles()],
})
export class JsEmptyStateComponent {
  @Input() title = "Nothing here yet";
  @Input() message = "";
  @Input() actionLabel = "";
  @Output() action = new EventEmitter<void>();
}

@Component({
  selector: "js-error-panel",
  standalone: true,
  template: `
    <section class="js-error" role="alert">
      <strong>{{ title }}</strong>
      <p>{{ message }}</p>
    </section>
  `,
  styles: [
    `
      .js-error {
        background: var(--js-color-danger-bg, #fef2f2);
        border: 1px solid var(--js-color-danger-border, #fecaca);
        border-radius: 6px;
        color: var(--js-color-danger-text, #991b1b);
        padding: 0.75rem;
      }
      .js-error p {
        margin: 0.25rem 0 0;
      }
    `,
  ],
})
export class JsErrorPanelComponent {
  @Input() title = "Something went wrong";
  @Input() message = "";
}

@Component({
  selector: "js-status-badge",
  standalone: true,
  template: `<span class="js-status" [attr.data-status]="value">{{ label }}</span>`,
  styles: [
    `
      .js-status {
        background: var(--js-color-status-bg, #eef2ff);
        border: 1px solid var(--js-color-status-border, #c7d2fe);
        border-radius: 999px;
        color: var(--js-color-status-text, #3730a3);
        display: inline-flex;
        font-size: 0.8125rem;
        line-height: 1;
        padding: 0.25rem 0.5rem;
      }
    `,
  ],
})
export class JsStatusBadgeComponent {
  @Input() value: unknown;

  get label(): string {
    return humanize(this.value);
  }
}

@Component({
  selector: "js-resource-list",
  standalone: true,
  imports: [CommonModule, JsEmptyStateComponent, JsErrorPanelComponent, JsStatusBadgeComponent],
  template: `
    <section class="js-resource-list">
      <header class="js-section-header">
        <h2>{{ resource.title }}</h2>
        <button type="button" (click)="createResource.emit()">Create</button>
      </header>
      <p *ngIf="loading" role="status">Loading...</p>
      <js-error-panel *ngIf="error" [message]="error"></js-error-panel>
      <js-empty-state
        *ngIf="!loading && !error && items.length === 0"
        title="No records"
        [message]="'No ' + resource.title + ' records were found.'"
      ></js-empty-state>
      <table *ngIf="!loading && !error && items.length > 0">
        <thead>
          <tr>
            <th *ngFor="let column of columns">{{ fieldLabel(column) }}</th>
          </tr>
        </thead>
        <tbody>
          <tr
            *ngFor="let item of items"
            tabindex="0"
            (click)="selectResource.emit(item.itemId)"
            (keydown.enter)="selectResource.emit(item.itemId)"
          >
            <td *ngFor="let column of columns">
              <js-status-badge
                *ngIf="column === 'status'; else plainValue"
                [value]="item.data[column]"
              ></js-status-badge>
              <ng-template #plainValue>{{ item.data[column] ?? "" }}</ng-template>
            </td>
          </tr>
        </tbody>
      </table>
    </section>
  `,
  styles: [tableStyles(), sectionHeaderStyles()],
})
export class JsResourceListComponent {
  private readonly api = inject(JAWSTACK_API_CLIENT);
  private readonly changeDetector = inject(ChangeDetectorRef);

  @Input({ required: true }) resource!: ResourceDefinition;
  @Input() viewName = "list";
  @Output() selectResource = new EventEmitter<string>();
  @Output() createResource = new EventEmitter<void>();

  loading = false;
  error = "";
  items: readonly ProjectionRecord[] = [];

  get columns(): readonly string[] {
    return this.resource.views.list?.columns ?? Object.keys(this.resource.state.fields);
  }

  ngOnChanges(): void {
    queueMicrotask(() => void this.load());
  }

  async load(): Promise<void> {
    if (this.resource === undefined) {
      return;
    }

    this.loading = true;
    this.error = "";

    try {
      const result = await this.api.list(this.resource.name, { viewName: this.viewName });
      this.items = result.items;
    } catch (error) {
      this.error = errorMessage(error);
      this.items = [];
    } finally {
      this.loading = false;
      this.changeDetector.detectChanges();
    }
  }

  fieldLabel(fieldName: string): string {
    return fieldLabel(this.resource, fieldName);
  }
}

@Component({
  selector: "js-resource-detail",
  standalone: true,
  imports: [CommonModule, JsErrorPanelComponent, JsStatusBadgeComponent],
  template: `
    <article class="js-resource-detail">
      <p *ngIf="loading" role="status">Loading...</p>
      <js-error-panel *ngIf="error" [message]="error"></js-error-panel>
      <ng-container *ngIf="!loading && !error && state">
        <header class="js-section-header">
          <h2>{{ title }}</h2>
          <js-status-badge
            *ngIf="state.state['status']"
            [value]="state.state['status']"
          ></js-status-badge>
        </header>
        <dl>
          <ng-container *ngFor="let field of fields">
            <dt>{{ fieldLabel(field) }}</dt>
            <dd>{{ state.state[field] ?? "" }}</dd>
          </ng-container>
        </dl>
      </ng-container>
    </article>
  `,
  styles: [sectionHeaderStyles(), definitionListStyles()],
})
export class JsResourceDetailComponent {
  private readonly api = inject(JAWSTACK_API_CLIENT);
  private readonly changeDetector = inject(ChangeDetectorRef);

  @Input({ required: true }) resource!: ResourceDefinition;
  @Input({ required: true }) resourceId = "";

  loading = false;
  error = "";
  state: ResourceState<Record<string, unknown>> | undefined;

  get fields(): readonly string[] {
    return Object.keys(this.resource.state.fields);
  }

  get title(): string {
    const titleField = this.resource.views.detail?.titleField;
    const value = titleField === undefined ? undefined : this.state?.state[titleField];
    return typeof value === "string" && value.length > 0 ? value : this.resource.title;
  }

  ngOnChanges(): void {
    queueMicrotask(() => void this.load());
  }

  async load(): Promise<void> {
    if (this.resource === undefined || this.resourceId.length === 0) {
      return;
    }

    this.loading = true;
    this.error = "";

    try {
      this.state = (await this.api.get(this.resource.name, this.resourceId)) as ResourceState<
        Record<string, unknown>
      >;
    } catch (error) {
      this.error = errorMessage(error);
      this.state = undefined;
    } finally {
      this.loading = false;
      this.changeDetector.detectChanges();
    }
  }

  fieldLabel(fieldName: string): string {
    return fieldLabel(this.resource, fieldName);
  }
}

@Component({
  selector: "js-activity-timeline",
  standalone: true,
  imports: [CommonModule, JsEmptyStateComponent, JsErrorPanelComponent],
  template: `
    <section class="js-activity">
      <h3>Activity</h3>
      <p *ngIf="loading" role="status">Loading activity...</p>
      <js-error-panel *ngIf="error" [message]="error"></js-error-panel>
      <js-empty-state
        *ngIf="!loading && !error && activity.length === 0"
        title="No activity"
        message="No activity has been recorded."
      ></js-empty-state>
      <ol *ngIf="!loading && !error && activity.length > 0">
        <li *ngFor="let item of activity">
          <strong>{{ item.title }}</strong>
          <span>{{ item.occurredAt }}</span>
          <p *ngIf="item.summary">{{ item.summary }}</p>
        </li>
      </ol>
    </section>
  `,
  styles: [
    `
      .js-activity h3 {
        font-size: 1rem;
        margin: 1.5rem 0 0.75rem;
      }
      .js-activity ol {
        border-left: 1px solid var(--js-color-border, #d1d5db);
        list-style: none;
        margin: 0;
        padding: 0 0 0 1rem;
      }
      .js-activity li {
        margin: 0 0 0.75rem;
      }
      .js-activity span {
        color: var(--js-color-muted, #6b7280);
        display: block;
        font-size: 0.8125rem;
      }
      .js-activity p {
        margin: 0.25rem 0 0;
      }
    `,
  ],
})
export class JsActivityTimelineComponent {
  private readonly api = inject(JAWSTACK_API_CLIENT);
  private readonly changeDetector = inject(ChangeDetectorRef);

  @Input({ required: true }) resource!: ResourceDefinition;
  @Input({ required: true }) resourceId = "";

  loading = false;
  error = "";
  activity: readonly ActivityRecord[] = [];

  ngOnChanges(): void {
    queueMicrotask(() => void this.load());
  }

  async load(): Promise<void> {
    if (this.resource === undefined || this.resourceId.length === 0) {
      return;
    }

    this.loading = true;
    this.error = "";

    try {
      this.activity = (await this.api.activity(this.resource.name, this.resourceId)).items;
    } catch (error) {
      this.error = errorMessage(error);
      this.activity = [];
    } finally {
      this.loading = false;
      this.changeDetector.detectChanges();
    }
  }
}

@Component({
  selector: "js-resource-form",
  standalone: true,
  imports: [CommonModule, FormsModule, JsErrorPanelComponent],
  template: `
    <form class="js-form" (submit)="submit($event)">
      <js-error-panel *ngIf="error" [message]="error"></js-error-panel>
      <fieldset *ngFor="let field of fields">
        <label [for]="field.name">{{ field.label }}</label>
        <select
          *ngIf="field.kind === 'enum'; else nonEnum"
          [id]="field.name"
          [name]="field.name"
          [required]="field.required"
          [ngModel]="model[field.name]"
          (ngModelChange)="setValue(field, $event)"
        >
          <option value=""></option>
          <option *ngFor="let option of field.options" [value]="option">
            {{ humanizeValue(option) }}
          </option>
        </select>
        <ng-template #nonEnum>
          <textarea
            *ngIf="field.kind === 'text'; else simpleInput"
            [id]="field.name"
            [name]="field.name"
            [required]="field.required"
            [ngModel]="model[field.name]"
            (ngModelChange)="setValue(field, $event)"
          ></textarea>
          <ng-template #simpleInput>
            <input
              [id]="field.name"
              [name]="field.name"
              [required]="field.required"
              [type]="inputType(field)"
              [ngModel]="model[field.name]"
              (ngModelChange)="setValue(field, $event)"
            />
          </ng-template>
        </ng-template>
      </fieldset>
      <div class="js-form__actions">
        <button type="button" (click)="cancelled.emit()">Cancel</button>
        <button type="submit">{{ submitLabel }}</button>
      </div>
    </form>
  `,
  styles: [
    `
      .js-form {
        display: grid;
        gap: 0.75rem;
      }
      fieldset {
        border: 0;
        display: grid;
        gap: 0.25rem;
        margin: 0;
        padding: 0;
      }
      label {
        font-weight: 600;
      }
      input,
      select,
      textarea {
        border: 1px solid var(--js-color-border, #d1d5db);
        border-radius: 6px;
        font: inherit;
        min-height: 2.25rem;
        padding: 0.4rem 0.5rem;
      }
      textarea {
        min-height: 5rem;
      }
      .js-form__actions {
        display: flex;
        gap: 0.5rem;
        justify-content: flex-end;
      }
    `,
  ],
})
export class JsResourceFormComponent {
  @Input({ required: true }) resource!: ResourceDefinition;
  @Input({ required: true }) commandName = "";
  @Input() initialValue: Record<string, unknown> = {};
  @Input() submitLabel = "Submit";
  @Output() submitted = new EventEmitter<unknown>();
  @Output() cancelled = new EventEmitter<void>();

  error = "";
  model: Record<string, unknown> = {};

  get command(): CommandDefinition | undefined {
    return this.resource.commands[this.commandName];
  }

  get fields(): readonly FormField[] {
    return this.command === undefined ? [] : formFieldsForCommand(this.resource, this.command);
  }

  ngOnChanges(): void {
    this.model = { ...this.initialValue };
  }

  inputType(field: FormField): string {
    if (field.kind === "boolean") {
      return "checkbox";
    }

    return field.kind === "datetime" ? "datetime-local" : "text";
  }

  humanizeValue(value: unknown): string {
    return humanize(value);
  }

  setValue(field: FormField, value: unknown): void {
    this.model = {
      ...this.model,
      [field.name]: normalizeFieldValue(field, value),
    };
  }

  submit(event: Event): void {
    event.preventDefault();
    const command = this.command;

    if (command === undefined) {
      this.error = `Unknown command "${this.commandName}".`;
      return;
    }

    const parsed = command.input.safeParse(cleanFormValue(this.model));

    if (!parsed.success) {
      this.error = parsed.error.issues[0]?.message ?? "Command input is invalid.";
      return;
    }

    this.error = "";
    this.submitted.emit(parsed.data);
  }
}

@Component({
  selector: "js-command-button",
  standalone: true,
  template: `
    <button type="button" [disabled]="disabled" (click)="pressed.emit()">
      {{ buttonLabel }}
    </button>
  `,
})
export class JsCommandButtonComponent {
  private readonly auth = inject(JAWSTACK_AUTH, { optional: true });

  @Input({ required: true }) resource!: ResourceDefinition;
  @Input() resourceId = "";
  @Input({ required: true }) commandName = "";
  @Input() label = "";
  @Output() pressed = new EventEmitter<void>();

  get command(): CommandDefinition | undefined {
    return this.resource.commands[this.commandName];
  }

  get disabled(): boolean {
    const roles = this.auth?.()?.roles ?? [];
    const requiredRoles = this.command?.roles ?? [];
    return requiredRoles.length > 0 && !requiredRoles.some((role) => roles.includes(role));
  }

  get buttonLabel(): string {
    return this.label || this.command?.title || humanize(this.commandName);
  }
}

@Component({
  selector: "js-command-dialog",
  standalone: true,
  imports: [CommonModule, JsErrorPanelComponent, JsResourceFormComponent],
  template: `
    <section *ngIf="open" class="js-dialog" role="dialog" aria-modal="true">
      <div class="js-dialog__panel">
        <header class="js-section-header">
          <h2>{{ commandTitle }}</h2>
          <button type="button" (click)="close()">Close</button>
        </header>
        <p *ngIf="loading" role="status">Submitting...</p>
        <js-error-panel *ngIf="error" [message]="error"></js-error-panel>
        <js-resource-form
          [resource]="resource"
          [commandName]="commandName"
          [submitLabel]="commandTitle"
          (submitted)="execute($event)"
          (cancelled)="close()"
        ></js-resource-form>
      </div>
    </section>
  `,
  styles: [
    sectionHeaderStyles(),
    `
      .js-dialog {
        align-items: center;
        background: rgb(17 24 39 / 0.35);
        display: flex;
        inset: 0;
        justify-content: center;
        position: fixed;
        z-index: 10;
      }
      .js-dialog__panel {
        background: var(--js-color-surface, #ffffff);
        border-radius: 8px;
        box-shadow: 0 20px 50px rgb(17 24 39 / 0.22);
        max-width: 34rem;
        padding: 1rem;
        width: min(34rem, calc(100vw - 2rem));
      }
    `,
  ],
})
export class JsCommandDialogComponent {
  private readonly api = inject(JAWSTACK_API_CLIENT);

  @Input({ required: true }) resource!: ResourceDefinition;
  @Input() resourceId: string | undefined;
  @Input({ required: true }) commandName = "";
  @Input() open = false;
  @Output() closed = new EventEmitter<void>();
  @Output() completed = new EventEmitter<unknown>();

  loading = false;
  error = "";

  get commandTitle(): string {
    return this.resource.commands[this.commandName]?.title ?? humanize(this.commandName);
  }

  close(): void {
    this.closed.emit();
  }

  async execute(input: unknown): Promise<void> {
    this.loading = true;
    this.error = "";

    try {
      const result = await this.api.command({
        resourceType: this.resource.name,
        ...(this.resourceId === undefined ? {} : { resourceId: this.resourceId }),
        commandName: this.commandName,
        input,
      });
      this.completed.emit(result);
      this.close();
    } catch (error) {
      this.error = errorMessage(error);
    } finally {
      this.loading = false;
    }
  }
}

type FormField = Readonly<{
  name: string;
  label: string;
  kind: FieldDefinition["kind"];
  required: boolean;
  options: readonly string[];
}>;

function panelStyles(): string {
  return `
  .js-empty {
    border: 1px dashed var(--js-color-border, #d1d5db);
    border-radius: 6px;
    padding: 1rem;
    text-align: center;
  }
  .js-empty h2 {
    font-size: 1rem;
    margin: 0;
  }
  .js-empty p {
    color: var(--js-color-muted, #6b7280);
    margin: 0.25rem 0 0.75rem;
  }
`;
}

function sectionHeaderStyles(): string {
  return `
  .js-section-header {
    align-items: center;
    display: flex;
    gap: 0.75rem;
    justify-content: space-between;
    margin-bottom: 0.75rem;
  }
  .js-section-header h2 {
    font-size: 1.125rem;
    margin: 0;
  }
`;
}

function tableStyles(): string {
  return `
  table {
    border-collapse: collapse;
    width: 100%;
  }
  th,
  td {
    border-bottom: 1px solid var(--js-color-border, #d1d5db);
    padding: 0.625rem;
    text-align: left;
  }
  th {
    color: var(--js-color-muted, #6b7280);
    font-size: 0.8125rem;
    font-weight: 600;
  }
  tbody tr {
    cursor: pointer;
  }
`;
}

function definitionListStyles(): string {
  return `
  dl {
    display: grid;
    gap: 0.5rem 1rem;
    grid-template-columns: max-content 1fr;
  }
  dt {
    color: var(--js-color-muted, #6b7280);
    font-weight: 600;
  }
  dd {
    margin: 0;
  }
`;
}

function authHeaders(auth: JawStackAuthState | undefined): Record<string, string> {
  if (auth === undefined) {
    return {};
  }

  return {
    "x-jawstack-subject": auth.subject,
    "x-jawstack-roles": auth.roles.join(","),
    ...(auth.displayName === undefined ? {} : { "x-jawstack-display-name": auth.displayName }),
    ...(auth.tenantId === undefined ? {} : { "x-jawstack-tenant-id": auth.tenantId }),
  };
}

function fieldLabel(resource: ResourceDefinition, fieldName: string): string {
  return resource.state.fields[fieldName]?.label ?? humanize(fieldName);
}

function humanize(value: unknown): string {
  if (typeof value !== "string") {
    return value === undefined || value === null ? "" : String(value);
  }

  return value
    .replaceAll(/([a-z])([A-Z])/gu, "$1 $2")
    .replaceAll(/[_-]+/gu, " ")
    .replace(/^./u, (first) => first.toUpperCase());
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unexpected JawStack error.";
}

function formFieldsForCommand(
  resource: ResourceDefinition,
  command: CommandDefinition,
): readonly FormField[] {
  return Object.entries(zodObjectShape(command.input)).map(([name, schema]) => {
    const stateField = resource.state.fields[name];
    const enumOptions = zodEnumOptions(schema);

    return {
      name,
      label: stateField?.label ?? humanize(name),
      kind: stateField?.kind ?? (enumOptions.length > 0 ? "enum" : "string"),
      required: !zodIsOptional(schema),
      options: stateField?.kind === "enum" ? stateField.values : enumOptions,
    };
  });
}

function zodObjectShape(schema: unknown): Record<string, unknown> {
  if (typeof schema !== "object" || schema === null) {
    return {};
  }

  const shape = (schema as { shape?: unknown }).shape;
  return typeof shape === "object" && shape !== null && !Array.isArray(shape)
    ? (shape as Record<string, unknown>)
    : {};
}

function zodEnumOptions(schema: unknown): readonly string[] {
  const definition = zodDefinition(schema);
  const entries = definition?.entries;

  if (typeof entries === "object" && entries !== null && !Array.isArray(entries)) {
    return Object.keys(entries);
  }

  return [];
}

function zodIsOptional(schema: unknown): boolean {
  return zodDefinition(schema)?.type === "optional";
}

function zodDefinition(schema: unknown): Record<string, unknown> | undefined {
  if (typeof schema !== "object" || schema === null) {
    return undefined;
  }

  const definition = (schema as { _def?: unknown })._def;
  return typeof definition === "object" && definition !== null
    ? (definition as Record<string, unknown>)
    : undefined;
}

function normalizeFieldValue(field: FormField, value: unknown): unknown {
  if (field.kind === "boolean") {
    return value === true || value === "true";
  }

  return value;
}

function cleanFormValue(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== "" && entry !== undefined),
  );
}
