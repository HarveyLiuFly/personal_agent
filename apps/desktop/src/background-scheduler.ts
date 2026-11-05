export interface BackgroundStep {
  name: string;
  run: () => unknown;
}
export interface BackgroundSchedulerOptions {
  steps: BackgroundStep[];
  /** Ledger write counter (`total_changes()`); a cycle runs only after writes it did not make. */
  changeCount: () => number;
  /** Earliest time work may become due without any other change, or null. */
  nextDueAt: () => number | null;
  /** False while the Host must not advance background work (restore/runtime transition). */
  enabled?: () => boolean;
  onError?: (step: string, error: unknown) => void;
  /** Called after each cycle (e.g. to turn the cycle's writes into a Renderer notice). */
  afterCycle?: () => void;
  /** Minimum time between cycles started by changes (default 1 s). */
  minIntervalMs?: number;
  /** Longest sleep even when nothing is due (default 30 s). */
  safetyMs?: number;
  /** Follow-up cycles allowed while a cycle keeps writing (default 8). */
  maxChained?: number;
  now?: () => number;
}

/**
 * Advances background work (outbox, plans, routes, schedules) only when something changed or
 * something becomes due, instead of on a fixed 250 ms / 1 s tick. Writes made by a cycle itself
 * do not trigger another cycle beyond `maxChained` follow-ups, so steps that write while idle
 * cannot make it spin.
 */
export class BackgroundScheduler {
  private options: Required<
    Omit<BackgroundSchedulerOptions, 'enabled' | 'onError' | 'afterCycle'>
  > &
    Pick<BackgroundSchedulerOptions, 'enabled' | 'onError' | 'afterCycle'>;
  private lastSeen: number;
  private lastCycleEnd = -Infinity;
  private running = false;
  private pending = false;
  private stopped = false;
  private timer?: NodeJS.Timeout;
  private timerAt = Infinity;
  /** Cycles completed (diagnostics and tests). */
  cycles = 0;
  constructor(options: BackgroundSchedulerOptions) {
    this.options = {
      minIntervalMs: 1000,
      safetyMs: 30_000,
      maxChained: 8,
      now: Date.now,
      ...options,
    };
    this.lastSeen = options.changeCount();
  }
  /** Something may have changed; runs a cycle if the ledger was written outside the scheduler. */
  kick(): void {
    if (this.stopped) return;
    let current: number;
    try {
      current = this.options.changeCount();
    } catch {
      return;
    }
    if (current === this.lastSeen) return;
    this.request();
  }
  /** Runs a cycle as soon as allowed, regardless of changes (startup and due times). */
  request(): void {
    if (this.stopped) return;
    if (this.running) {
      this.pending = true;
      return;
    }
    const wait = Math.max(0, this.lastCycleEnd + this.options.minIntervalMs - this.options.now());
    this.arm(this.options.now() + wait);
  }
  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = undefined;
  }
  private arm(at: number): void {
    if (this.stopped || (this.timer && this.timerAt <= at)) return;
    clearTimeout(this.timer);
    this.timerAt = at;
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        this.timerAt = Infinity;
        void this.cycle();
      },
      Math.max(0, at - this.options.now()),
    );
  }
  private async cycle(): Promise<void> {
    if (this.stopped) return;
    if (this.options.enabled && !this.options.enabled()) {
      this.arm(this.options.now() + this.options.safetyMs);
      return;
    }
    this.running = true;
    try {
      for (let round = 0; round <= this.options.maxChained; round++) {
        const before = this.options.changeCount();
        for (const step of this.options.steps) {
          try {
            await step.run();
          } catch (error) {
            this.options.onError?.(step.name, error);
          }
        }
        this.lastSeen = this.options.changeCount();
        if (this.lastSeen === before) break;
      }
    } finally {
      this.running = false;
      this.cycles++;
      this.lastCycleEnd = this.options.now();
      this.options.afterCycle?.();
    }
    if (this.pending) {
      this.pending = false;
      this.kick();
    }
    const due = this.options.nextDueAt();
    const safety = this.options.now() + this.options.safetyMs;
    this.arm(due === null ? safety : Math.min(Math.max(due, this.options.now()), safety));
  }
}
