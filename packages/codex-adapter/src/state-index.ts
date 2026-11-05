import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { restrictedAppServerArguments, runtimeEnvironment } from './launch.ts';

export interface StateIndexStatus {
  /** Codex backfill status (`pending`, `running`, `complete`, …), or `missing` before the first start. */
  status: string;
  threads: number;
}

/**
 * Reads the private Codex state index of `stateDirectory` (the app-server `sqlite_home`) read-only.
 * Codex fills it from the whole `~/.codex` history on the first start of each state directory.
 */
export function readStateIndex(stateDirectory: string): StateIndexStatus {
  const file = join(stateDirectory, 'db/state_5.sqlite');
  if (!existsSync(file)) return { status: 'missing', threads: 0 };
  try {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const row = db.prepare('SELECT status FROM backfill_state WHERE id = 1').get() as
        { status?: string } | undefined;
      const threads = Number(
        (db.prepare('SELECT COUNT(*) AS n FROM threads').get() as { n?: number } | undefined)?.n ??
          0,
      );
      return { status: row?.status ?? 'pending', threads };
    } finally {
      db.close();
    }
  } catch {
    return { status: 'unreadable', threads: 0 };
  }
}

export type WarmupState = 'idle' | 'indexing' | 'waiting' | 'complete' | 'failed';
export interface WarmupOptions {
  executable: string;
  stateDirectory: string;
  env?: NodeJS.ProcessEnv;
  /** How often the index row is read while a warm-up process runs (default 2 s). */
  pollMs?: number;
  /** Wait before retrying after the process exited early, e.g. behind a stale lease (default 60 s). */
  retryMs?: number;
  /** Give up after this long (default 25 min). */
  limitMs?: number;
  onChange?: (state: WarmupState, index: StateIndexStatus) => void;
}

/**
 * Keeps one app-server alive (initialize only; no model request) until the private state index is
 * complete. An app-server that is killed mid-backfill leaves a `running` lease that makes every
 * later start wait 30 s and exit for ~15 minutes; a warm-up process has no request timeout, so the
 * first backfill can finish. A process that exits early (another worker's lease) is retried.
 */
export class StateIndexWarmup {
  private options: WarmupOptions;
  private child?: ChildProcess;
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private started = 0;
  /** Settles the promise returned by start(); also called by stop(). */
  private settle?: (state: WarmupState) => void;
  state: WarmupState = 'idle';
  index: StateIndexStatus = { status: 'missing', threads: 0 };
  constructor(options: WarmupOptions) {
    this.options = options;
  }
  /** True while the index is being built or waited for. */
  get active(): boolean {
    return this.state === 'indexing' || this.state === 'waiting';
  }
  /** Starts warming unless the index is already complete. Resolves when complete, failed or stopped. */
  start(): Promise<WarmupState> {
    this.index = readStateIndex(this.options.stateDirectory);
    if (this.index.status === 'complete') {
      this.set('complete');
      return Promise.resolve(this.state);
    }
    this.started = Date.now();
    return new Promise((resolve) => {
      this.settle = (state) => {
        this.settle = undefined;
        resolve(state);
      };
      this.attempt((state) => this.settle?.(state));
    });
  }
  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.kill();
    if (this.active) this.set('idle');
    this.settle?.(this.state);
  }
  private set(state: WarmupState): void {
    const changed = state !== this.state;
    this.state = state;
    if (changed) this.options.onChange?.(state, this.index);
  }
  private kill(): void {
    if (this.child && this.child.exitCode === null && this.child.signalCode === null) {
      this.child.stdin?.end();
      this.child.kill('SIGTERM');
    }
    this.child = undefined;
  }
  private attempt(resolve: (state: WarmupState) => void): void {
    if (this.stopped) return resolve(this.state);
    if (Date.now() - this.started > (this.options.limitMs ?? 25 * 60_000)) {
      this.set('failed');
      return resolve(this.state);
    }
    this.set('indexing');
    // Same restricted process flags as the Host metadata connection: no MCP servers, apps, plugins
    // or tools start just to build the index.
    const child = spawn(
      this.options.executable,
      restrictedAppServerArguments(this.options.stateDirectory, true),
      {
        env: this.options.env ?? runtimeEnvironment(),
        stdio: ['pipe', 'ignore', 'ignore'],
      },
    );
    this.child = child;
    child.on('error', () => undefined);
    child.stdin?.on('error', () => undefined);
    child.stdin?.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          clientInfo: { name: 'personal_agent_desktop', title: 'Personal Agent', version: '0.1.0' },
          capabilities: { experimentalApi: false, requestAttestation: false },
        },
      }) + '\n',
    );
    let lastThreads = -1;
    const poll = () => {
      if (this.stopped) return resolve(this.state);
      this.index = readStateIndex(this.options.stateDirectory);
      if (this.index.status === 'complete') {
        this.kill();
        this.set('complete');
        return resolve(this.state);
      }
      if (this.index.threads !== lastThreads) {
        lastThreads = this.index.threads;
        this.options.onChange?.(this.state, this.index);
      }
      if (child.exitCode !== null || child.signalCode !== null) {
        // Exited before the index finished: most likely waiting behind a stale lease.
        this.child = undefined;
        this.set('waiting');
        this.timer = setTimeout(() => this.attempt(resolve), this.options.retryMs ?? 60_000);
        return;
      }
      this.timer = setTimeout(poll, this.options.pollMs ?? 2000);
    };
    this.timer = setTimeout(poll, Math.min(500, this.options.pollMs ?? 2000));
  }
}
