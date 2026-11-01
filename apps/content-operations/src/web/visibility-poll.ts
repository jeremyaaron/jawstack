export class VisibilityPoll {
  private task: ((signal: AbortSignal) => Promise<boolean>) | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private controller: AbortController | undefined;
  private generation = 0;
  private started = 0;
  private readonly changed = () => {
    this.pause();
    this.schedule();
  };
  constructor(
    private readonly document: Document,
    private readonly now = () => Date.now(),
  ) {
    document.addEventListener("visibilitychange", this.changed);
  }
  start(task: (signal: AbortSignal) => Promise<boolean>) {
    this.stop();
    this.task = task;
    this.started = this.now();
    this.schedule();
  }
  private pause() {
    this.generation++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.controller?.abort();
  }
  private schedule() {
    if (!this.task || this.document.hidden) return;
    const generation = this.generation;
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        const controller = new AbortController();
        this.controller = controller;
        void this.task!(controller.signal)
          .then(
            (keep) => {
              if (!keep && generation === this.generation) this.task = undefined;
            },
            () => {},
          )
          .finally(() => {
            if (generation === this.generation) this.schedule();
          });
      },
      this.now() - this.started < 60_000 ? 2000 : 10_000,
    );
  }
  stop() {
    this.task = undefined;
    this.pause();
  }
  destroy() {
    this.stop();
    this.document.removeEventListener("visibilitychange", this.changed);
  }
}
