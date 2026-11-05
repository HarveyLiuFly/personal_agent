import type { HostEvent } from './bridge.ts';

/** What changed: the ledger (any persisted state) or a project's terminal output. */
export type HostTopic = HostEvent['topic'];

/**
 * Turns ledger writes and terminal output into coalesced change notices.
 * `check()` is cheap (one `total_changes()` read) and is called after IPC requests, background
 * steps and, only while Runs execute, on a short timer. Nothing runs while the app is idle.
 */
export class HostEvents {
  private seq = 0;
  private lastChanges: number;
  private pending = new Map<string, { topic: HostTopic; projectId?: string }>();
  private timer?: NodeJS.Timeout;
  private watch?: NodeJS.Timeout;
  private send: (event: HostEvent) => void;
  private changeCount: () => number;
  private delayMs: number;
  constructor(send: (event: HostEvent) => void, changeCount: () => number, delayMs = 150) {
    this.send = send;
    this.changeCount = changeCount;
    this.delayMs = delayMs;
    this.lastChanges = changeCount();
  }
  /** Emits a `store` notice when the ledger has written anything since the last check. */
  check(): void {
    let current: number;
    try {
      current = this.changeCount();
    } catch {
      return;
    }
    if (current === this.lastChanges) return;
    this.lastChanges = current;
    this.emit('store');
  }
  emit(topic: HostTopic, projectId?: string): void {
    this.pending.set(`${topic}:${projectId ?? ''}`, { topic, ...(projectId ? { projectId } : {}) });
    this.timer ??= setTimeout(() => this.flush(), this.delayMs);
  }
  /** Checks for ledger writes every `intervalMs` while `active()` holds (e.g. Runs streaming). */
  watchWhile(active: () => boolean, intervalMs = 200): void {
    if (this.watch) return;
    this.watch = setInterval(() => {
      this.check();
      if (!active()) {
        clearInterval(this.watch);
        this.watch = undefined;
      }
    }, intervalMs);
  }
  close(): void {
    clearTimeout(this.timer);
    clearInterval(this.watch);
    this.timer = this.watch = undefined;
    this.pending.clear();
  }
  private flush(): void {
    this.timer = undefined;
    const events = [...this.pending.values()];
    this.pending.clear();
    for (const event of events) {
      try {
        this.send({ seq: ++this.seq, ...event });
      } catch {
        /* The window may be gone; the next read refreshes everything anyway. */
      }
    }
  }
}
