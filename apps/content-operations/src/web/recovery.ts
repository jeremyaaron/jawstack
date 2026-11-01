import { CommonModule } from "@angular/common";
import {
  Component,
  Input,
  Output,
  EventEmitter,
  DestroyRef,
  ElementRef,
  ChangeDetectorRef,
  inject,
  type OnChanges,
  type SimpleChanges,
} from "@angular/core";
import { RouterLink } from "@angular/router";
import { LucideRotateCcw, LucideRefreshCw } from "@lucide/angular";
import type { ContentResource } from "./client";
import { Workspace } from "./workspace";
import { RecoverySession } from "./recovery-session";
import { limits } from "../shared/validation";

@Component({
  selector: "publication-recovery",
  standalone: true,
  imports: [CommonModule, RouterLink, LucideRotateCcw, LucideRefreshCw],
  template: `
    @if (row.state.publication; as publication) {
      <section class="recovery-section" aria-label="Publication recovery">
        <header class="section-heading">
          <h3
            class="recovery-state"
            tabindex="-1"
            aria-live="polite"
            [attr.data-status]="session.policy()?.status"
          >
            {{ label(session.policy()?.status ?? publication.phase) }}
          </h3>
          <button
            type="button"
            class="icon-button"
            aria-label="Refresh publication"
            title="Refresh publication"
            [disabled]="blocked || session.pending()"
            (click)="refresh()"
          >
            <svg lucideRefreshCw aria-hidden="true"></svg>
          </button>
        </header>
        @if (session.action.error() || session.error()) {
          <p class="validation" role="alert" tabindex="-1">
            {{ session.action.error() || session.error() }}
          </p>
        }
        @if (session.awaiting()) {
          <p role="status">Retry acknowledged; latest status pending</p>
        }
        <dl class="operation-metadata">
          <dt>Publication</dt>
          <dd>{{ publication.intent.publicationId }}</dd>
          <dt>Loaded content version</dt>
          <dd>{{ row.version }}</dd>
          <dt>Recorded phase</dt>
          <dd>{{ publication.phase }}</dd>
          <dt>Generation</dt>
          <dd>{{ publication.generation }} / {{ limits.publicationGenerations }}</dd>
          <dt>Attempts this generation</dt>
          <dd>{{ publication.attemptsInGeneration }} / {{ limits.publicationAttempts }}</dd>
          <dt>Manual retries remaining</dt>
          <dd>{{ session.policy()?.remainingGenerations }}</dd>
          @if (publication.claim; as claim) {
            <dt>Lease</dt>
            <dd>
              {{ session.policy()?.liveLease ? "Active" : "Expired" }} ·
              <time [dateTime]="claim.leaseUntil">{{ claim.leaseUntil }}</time>
            </dd>
          }
          @if (publication.lastAttempt; as attempt) {
            <dt>Last attempt</dt>
            <dd>{{ attempt.status }} · generation {{ attempt.generation }}</dd>
            <dt>Correlation</dt>
            <dd>{{ attempt.correlationId }}</dd>
            @if (attempt.failureCode) {
              <dt>Failure code</dt>
              <dd>{{ attempt.failureCode }}</dd>
            }
          }
          @if (publication.deliveryFailure; as failure) {
            <dt>Exhausted delivery</dt>
            <dd>
              <a
                class="inline-link"
                routerLink="/operations"
                [queryParams]="{ view: 'failures', contentId: row.resourceId }"
                >{{ failure.failureId }}</a
              >
            </dd>
          }
        </dl>
        @if (session.policy()?.expiredLease) {
          <p class="muted">Lease expired; completion is not confirmed.</p>
        }
        @if (row.state.status === "publishing") {
          @if (!workspace.fixture().startsWith("editor")) {
            <p class="muted">Only an editor can retry publication.</p>
          } @else {
            <button
              type="button"
              class="button"
              [disabled]="
                blocked ||
                session.pending() ||
                session.awaiting() ||
                session.action.conflict() ||
                !session.canRetry()
              "
              (click)="retry()"
            >
              <svg lucideRotateCcw aria-hidden="true"></svg
              >{{ session.pending() ? "Checking publication" : "Retry publication" }}
            </button>
            @if (session.policy()?.liveLease) {
              <p class="muted">An active lease prevents manual retry.</p>
            } @else if (!session.policy()?.remainingGenerations) {
              <p class="muted">Manual publication retry budget exhausted.</p>
            } @else if (!session.policy()?.hasRecoverableWork) {
              <p class="muted">No failed or stalled attempt is eligible for manual retry.</p>
            }
          }
        }
      </section>
    }
  `,
})
export class RecoveryComponent implements OnChanges {
  @Input({ required: true }) row!: ContentResource;
  @Input() blocked = false;
  @Output() readonly changed = new EventEmitter<ContentResource>();
  @Output() readonly busy = new EventEmitter<boolean>();
  readonly workspace = inject(Workspace);
  private readonly destroy = inject(DestroyRef);
  private readonly change = inject(ChangeDetectorRef);
  private readonly element: ElementRef<HTMLElement> = inject(ElementRef);
  readonly limits = limits;
  readonly session = new RecoverySession(
    this.workspace.client,
    () => this.workspace.fixture(),
    () => this.row,
    (row) => this.changed.emit(row),
    document,
    () => this.blocked,
  );
  constructor() {
    this.destroy.onDestroy(() => this.session.destroy());
  }
  ngOnChanges(changes: SimpleChanges) {
    if (changes["row"]) this.session.update();
  }
  label(status: string) {
    return status.charAt(0).toUpperCase() + status.slice(1);
  }
  async retry() {
    if (!this.session.pending() && !this.blocked) await this.run(() => this.session.retry());
  }
  async refresh() {
    if (!this.session.pending() && !this.blocked) await this.run(() => this.session.refresh());
  }
  private async run(task: () => Promise<void>) {
    this.busy.emit(true);
    try {
      await task();
    } finally {
      this.busy.emit(false);
      if (!this.destroy.destroyed) {
        this.change.detectChanges();
        this.element.nativeElement
          .querySelector<HTMLElement>('[role="alert"],.recovery-state')
          ?.focus();
      }
    }
  }
}
