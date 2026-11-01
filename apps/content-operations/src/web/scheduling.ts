import { CommonModule } from "@angular/common";
import { Component, Input, ElementRef, ChangeDetectorRef, DestroyRef, inject } from "@angular/core";
import { ReactiveFormsModule } from "@angular/forms";
import { RouterLink } from "@angular/router";
import { LucideCalendarClock, LucideCalendarDays, LucideCalendarX, LucideX } from "@lucide/angular";
import { localDateAt, zonedLabel, timeZones } from "../shared/time";
import { ScheduleSession } from "./schedule-session";

@Component({
  selector: "content-scheduling",
  standalone: true,
  imports: [
    CommonModule,
    ReactiveFormsModule,
    RouterLink,
    LucideCalendarClock,
    LucideCalendarDays,
    LucideCalendarX,
    LucideX,
  ],
  template: `
    <section class="media-section" aria-label="Scheduling">
      <header class="section-heading">
        <h2>Scheduling</h2>
        @if (session.row()?.state?.schedule; as schedule) {
          <a
            class="inline-link"
            routerLink="/calendar"
            [queryParams]="{
              date: localDate(schedule.scheduledAt, schedule.timeZone),
              zone: schedule.timeZone,
              view: 'month',
            }"
            ><svg lucideCalendarDays aria-hidden="true"></svg>Calendar</a
          >
        }
      </header>
      @if (session.row()?.state?.schedule; as schedule) {
        <div class="schedule-summary" tabindex="-1">
          <strong>Scheduled</strong>
          <time [dateTime]="schedule.scheduledAt">{{
            label(schedule.scheduledAt, schedule.timeZone)
          }}</time>
          <span class="muted">{{ schedule.timeZone }}</span>
          <time class="muted" [dateTime]="schedule.scheduledAt"
            >{{ schedule.scheduledAt }} UTC</time
          >
        </div>
      } @else if (session.row()?.state?.status === "publishing") {
        <p class="muted">Publishing has started. Scheduling and reopening are locked.</p>
      } @else if (session.row()?.state?.status === "published") {
        <p class="muted">Publication committed. Scheduling is closed.</p>
      } @else if (!session.editable()) {
        <p class="muted">No active schedule</p>
      }
      @if (session.action.error() || session.error()) {
        <p class="validation" role="alert">{{ session.action.error() || session.error() }}</p>
      }
      @if (session.message()) {
        <p class="save-state" role="status" tabindex="-1">{{ session.message() }}</p>
      }
      @if (session.editable()) {
        <form class="scheduling-form" [formGroup]="session.form" (ngSubmit)="save()">
          <fieldset [disabled]="blocked || session.pending() || session.action.conflict()">
            <label for="schedule-at"
              >Publication time<input
                id="schedule-at"
                type="datetime-local"
                step="0.001"
                formControlName="at"
                required
                [attr.aria-invalid]="session.validation() ? true : null"
                [attr.aria-describedby]="session.validation() ? 'schedule-validation' : null"
            /></label>
            <label for="schedule-zone"
              >Publication time zone<select
                id="schedule-zone"
                aria-label="Publication time zone"
                formControlName="zone"
              >
                @for (zone of zones(); track zone) {
                  <option [value]="zone">{{ zone }}</option>
                }
              </select></label
            >
            <button
              class="button primary"
              type="submit"
              [disabled]="session.row()?.state?.status === 'scheduled' && !session.dirty()"
            >
              <svg lucideCalendarClock aria-hidden="true"></svg
              >{{
                session.pending()
                  ? "Saving schedule"
                  : session.row()?.state?.schedule
                    ? "Reschedule"
                    : "Schedule publication"
              }}
            </button>
          </fieldset>
          @if (session.instant(); as instant) {
            <p class="muted schedule-instant">
              UTC instant <time [dateTime]="instant">{{ instant }}</time>
            </p>
          }
          @if (session.validation()) {
            <p id="schedule-validation" class="validation" role="alert">
              {{ session.validation() }}
            </p>
          }
        </form>
        @if (session.row()?.state?.schedule) {
          <button
            class="button"
            type="button"
            [disabled]="blocked || session.pending() || session.action.conflict()"
            (click)="cancel()"
          >
            <svg lucideCalendarX aria-hidden="true"></svg>Cancel schedule
          </button>
        }
      } @else if (session.dirty()) {
        <div class="retained-schedule">
          <label
            >Unapplied local time<input [value]="session.form.controls.at.value" readonly
          /></label>
          <label
            >Unapplied time zone<input [value]="session.form.controls.zone.value" readonly
          /></label>
          <button class="button" type="button" (click)="session.reset(session.row())">
            <svg lucideX aria-hidden="true"></svg>Discard schedule changes
          </button>
        </div>
      }
    </section>
  `,
})
export class SchedulingComponent {
  @Input({ required: true }) session!: ScheduleSession;
  @Input() blocked = false;
  private readonly element: ElementRef<HTMLElement> = inject(ElementRef);
  private readonly change = inject(ChangeDetectorRef);
  private readonly destroy = inject(DestroyRef);
  readonly label = zonedLabel;
  readonly localDate = localDateAt;
  zones() {
    return timeZones(this.session.form.controls.zone.value);
  }
  async save() {
    await this.session.save();
    this.focusResult();
  }
  async cancel() {
    if (
      this.session.dirty() &&
      !window.confirm("Discard unsaved schedule changes and cancel the schedule?")
    )
      return;
    await this.session.cancel();
    this.focusResult();
  }
  private focusResult() {
    if (this.destroy.destroyed) return;
    this.change.detectChanges();
    const selector = this.session.validation()
      ? "#schedule-at"
      : this.session.message()
        ? '[role="status"]'
        : '[role="alert"]';
    const target = this.element.nativeElement.querySelector<HTMLElement>(selector);
    if (target) {
      if (!target.hasAttribute("tabindex") && target.tagName !== "INPUT")
        target.setAttribute("tabindex", "-1");
      target.focus();
    }
  }
}
