import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Stable, non-sensitive description of an error: its code when it has one, else its class name. */
export function errorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string')
    return error.code.slice(0, 100);
  return error instanceof Error ? error.name : 'UNKNOWN_ERROR';
}

/**
 * Records failures of background loops (scheduler, outbox, goals, routes) that used to be swallowed.
 * The same source+code is written at most once per minute; the file rotates at 1 MB.
 */
export class BackgroundLog {
  private file: string;
  private last = new Map<string, number>();
  constructor(directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.file = join(directory, 'background.log');
  }
  record(source: string, error: unknown, now = Date.now()): void {
    const code = errorCode(error),
      key = `${source}:${code}`;
    if (now - (this.last.get(key) ?? -Infinity) < 60_000) return;
    this.last.set(key, now);
    const line = `${new Date(now).toISOString()} ${source} ${code}\n`;
    try {
      if ((statSync(this.file, { throwIfNoEntry: false })?.size ?? 0) > 1_048_576)
        renameSync(this.file, this.file + '.1');
      appendFileSync(this.file, line, { mode: 0o600 });
    } catch {
      /* Logging must never break the loop it observes. */
    }
    console.warn(`[personal-agent] background ${source} failed: ${code}`);
  }
}
