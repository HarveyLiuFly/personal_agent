import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { StdioRpcClient, RpcFailure } from './rpc.ts';
import type { RpcOptions } from './rpc.ts';
import type { ReadPort } from './history.ts';

const initialization = {
  clientInfo: { name: 'personal_agent_desktop', title: 'Personal Agent', version: '0.1.0' },
  capabilities: { experimentalApi: false, requestAttestation: false },
};
const reads = new Set([
  'model/list',
  'thread/list',
  'thread/read',
  'thread/turns/list',
  'thread/items/list',
]);
/** Local thread bookkeeping a maintenance lease may change; never a model or tool call. */
const maintenance = new Set(['thread/archive', 'thread/unarchive']);
/** Codex filters `thread/list` by folder slowly (11–16 s measured with ~2,100 threads). */
const readDeadlines: Record<string, number> = { 'thread/list': 60_000 };
type State = 'idle' | 'starting' | 'ready' | 'failed' | 'closing' | 'closed';
type Options = Pick<
  RpcOptions,
  'executable' | 'args' | 'env' | 'initializeTimeoutMs' | 'requestTimeoutMs' | 'maximumFrameBytes'
>;
function stamp(file: string): string {
  try {
    const s = statSync(file, { bigint: true });
    return `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}`;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    throw new RpcFailure('APP_SERVER_IDENTITY_UNAVAILABLE');
  }
}
/** Rejects as soon as the signal aborts; the underlying work continues. */
function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new RpcFailure('CLIENT_ABORTED'));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new RpcFailure('CLIENT_ABORTED'));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}
function identity(options: Options): string {
  const env = options.env ?? {},
    home = env.CODEX_HOME ?? join(env.HOME ?? homedir(), '.codex');
  return createHash('sha256')
    .update(
      JSON.stringify({
        executable: options.executable,
        binary: stamp(options.executable),
        args: options.args,
        env: Object.entries(env).sort(([a], [b]) => a.localeCompare(b)),
        files: [
          join(home, 'config.toml'),
          join(home, 'auth.json'),
          resolve('.codex/config.toml'),
        ].map(stamp),
      }),
    )
    .digest('hex');
}
/** Main-owned metadata connection and dedicated execution children. Never accepts Renderer input. */
export class AppServerRuntime {
  private client?: StdioRpcClient;
  private key?: string;
  /** Settles when each admitted lease (waiting or running) ends; a reset waits for all. */
  private leases = new Set<Promise<void>>();
  private active = 0;
  private waiters: Array<() => void> = [];
  private starting?: Promise<StdioRpcClient>;
  private resetting?: Promise<void>;
  private stopped = false;
  private fence = 0;
  private queue = 0;
  private state: State = 'idle';
  private generation = 0;
  private starts = 0;
  private initializations = 0;
  private reused = 0;
  private failureCode: string | null = null;
  private retryAfter = 0;
  /** Fence and launch identity of the last connection that finished initializing. */
  private initialized?: { fence: number; key: string };
  private children = new Set<StdioRpcClient>();
  private options: () => Options;
  private limits: {
    maximumQueue?: number;
    /** Leases running at once on the metadata connection (default 4). */
    concurrency?: number;
    rotateAfterRequests?: number;
    backfillCooldownMs?: number;
    now?: () => number;
    /** Error code that fails reads fast without starting a process (e.g. while the Host warms the index). */
    blocked?: () => string | null;
  };
  constructor(
    options: () => Options,
    limits: {
      maximumQueue?: number;
      concurrency?: number;
      rotateAfterRequests?: number;
      backfillCooldownMs?: number;
      now?: () => number;
      blocked?: () => string | null;
    } = {},
  ) {
    this.options = options;
    this.limits = limits;
  }
  snapshot() {
    return {
      state: this.state,
      generation: this.generation,
      starts: this.starts,
      initializations: this.initializations,
      reused: this.reused,
      queued: this.queue,
      metadataPid: this.client?.processId ?? null,
      dedicatedProcesses: this.children.size,
      failureCode: this.failureCode,
    };
  }
  private check(fence: number, signal?: AbortSignal) {
    if (this.stopped) throw new RpcFailure('APP_SERVER_CLOSED');
    if (this.resetting || fence !== this.fence) throw new RpcFailure('APP_SERVER_CONTEXT_CHANGED');
    if (signal?.aborted) throw new RpcFailure('CLIENT_ABORTED');
  }
  private async retire(client: StdioRpcClient): Promise<void> {
    if (this.client === client) {
      this.client = undefined;
      this.key = undefined;
      this.state = 'closing';
    }
    await client.close();
    if (!this.client) this.state = this.stopped ? 'closed' : 'idle';
  }
  /** Waits for one of the concurrent lease slots (FIFO); an aborted waiter leaves the queue. */
  private async slot(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new RpcFailure('CLIENT_ABORTED');
    if (this.active < (this.limits.concurrency ?? 4)) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const grant = () => {
        signal?.removeEventListener('abort', cancel);
        this.active++;
        resolve();
      };
      const cancel = () => {
        const index = this.waiters.indexOf(grant);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new RpcFailure('CLIENT_ABORTED'));
      };
      this.waiters.push(grant);
      signal?.addEventListener('abort', cancel, { once: true });
    });
  }
  private release(): void {
    this.active--;
    this.waiters.shift()?.();
  }
  private async ready(fence: number, signal?: AbortSignal): Promise<StdioRpcClient> {
    this.check(fence, signal);
    const starting = this.starting;
    if (starting) {
      // Concurrent leases share one start, including its failure, instead of spawning more.
      await abortable(starting, signal);
      if (this.starting === starting) this.starting = undefined;
      return this.ready(fence, signal);
    }
    let options: Options, key: string;
    try {
      options = this.options();
      key = identity(options);
    } catch (error) {
      if (this.client) await this.retire(this.client);
      this.state = 'failed';
      this.failureCode =
        error instanceof RpcFailure ? error.code : 'APP_SERVER_IDENTITY_UNAVAILABLE';
      throw error;
    }
    const now = (this.limits.now ?? Date.now)();
    if (this.key !== key) this.retryAfter = 0;
    if (
      this.client &&
      (!this.client.usable ||
        this.key !== key ||
        // Rotate only when no other lease is using the connection.
        (this.client.requestCount >= (this.limits.rotateAfterRequests ?? 2048) && this.active <= 1))
    )
      await this.retire(this.client);
    this.check(fence, signal);
    if (this.client) {
      this.reused++;
      return this.client;
    }
    if (now < this.retryAfter) throw new RpcFailure('CODEX_STATE_INDEX_PENDING');
    const blocked = this.limits.blocked?.();
    if (blocked) throw new RpcFailure(blocked);
    // Not tied to this lease's signal: an aborted caller must not kill a start others share.
    const start = this.start(options, key, fence);
    this.starting = start;
    void start.then(
      () => {
        if (this.starting === start) this.starting = undefined;
      },
      () => {
        if (this.starting === start) this.starting = undefined;
      },
    );
    return abortable(start, signal);
  }
  private async start(options: Options, key: string, fence: number): Promise<StdioRpcClient> {
    const client = new StdioRpcClient(options);
    this.client = client;
    this.key = key;
    this.starts++;
    this.generation++;
    this.state = 'starting';
    void client.waitClosed().then(() => {
      if (this.client === client) {
        this.client = undefined;
        this.state = 'failed';
        this.failureCode = 'PROCESS_EXITED';
      }
    });
    try {
      this.initializations++;
      await client.request('initialize', initialization);
      await client.notify('initialized');
      this.check(fence);
      if (!client.usable) throw new RpcFailure('PROCESS_EXITED');
      this.state = 'ready';
      this.failureCode = null;
      this.initialized = { fence, key };
      return client;
    } catch (error) {
      await this.retire(client);
      this.failureCode = error instanceof RpcFailure ? error.code : 'HOST_ERROR';
      if (this.failureCode === 'CODEX_STATE_INDEX_PENDING') {
        this.retryAfter =
          (this.limits.now ?? Date.now)() + (this.limits.backfillCooldownMs ?? 30000);
        this.key = key;
      }
      if (!this.stopped) this.state = 'failed';
      throw error;
    }
  }
  /**
   * Up to `concurrency` leases (default 4) share the one metadata connection; later ones wait in
   * order and the queue is bounded. A failed operation is never replayed. A lease-local failure
   * (remote error, invalid response, abort) leaves the connection serving the others; only a
   * broken or stale connection is retired. An aborted caller is rejected at once while its
   * in-flight request finishes in the background, still holding its slot.
   */
  read<T>(work: (port: ReadPort) => Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.admit(work, reads, signal);
  }
  /**
   * A lease for local thread bookkeeping (archive/unarchive) on the same restricted connection.
   * It can never start a thread, a turn or any tool.
   */
  maintain<T>(work: (port: ReadPort) => Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.admit(work, maintenance, signal);
  }
  private admit<T>(
    work: (port: ReadPort) => Promise<T>,
    allowed: ReadonlySet<string>,
    signal?: AbortSignal,
  ): Promise<T> {
    const fence = this.fence;
    try {
      this.check(fence, signal);
      if (this.queue >= (this.limits.maximumQueue ?? 32))
        throw new RpcFailure('APP_SERVER_QUEUE_LIMIT');
    } catch (error) {
      return Promise.reject(error);
    }
    this.queue++;
    const job = (async () => {
      await this.slot(signal);
      try {
        return await this.lease(work, allowed, fence, signal);
      } finally {
        this.release();
      }
    })();
    const settled: Promise<void> = job
      .then(
        () => {},
        () => {},
      )
      .finally(() => {
        this.queue--;
        this.leases.delete(settled);
      });
    this.leases.add(settled);
    return abortable(job, signal);
  }
  private async lease<T>(
    work: (port: ReadPort) => Promise<T>,
    allowed: ReadonlySet<string>,
    fence: number,
    signal?: AbortSignal,
  ): Promise<T> {
    const client = await this.ready(fence, signal);
    this.check(fence, signal);
    let live = true;
    const pending = new Set<Promise<unknown>>();
    const port: ReadPort = {
      request: <R>(method: string, params: unknown): Promise<R> => {
        if (!live) return Promise.reject(new RpcFailure('APP_SERVER_LEASE_EXPIRED'));
        try {
          this.check(fence, signal);
          if (!allowed.has(method)) throw new RpcFailure('READ_METHOD_NOT_ALLOWED');
        } catch (error) {
          return Promise.reject(error);
        }
        const request = client.request<R>(method, params, readDeadlines[method]);
        pending.add(request);
        void request.then(
          () => pending.delete(request),
          () => pending.delete(request),
        );
        return request;
      },
    };
    try {
      const result = await work(port);
      this.check(fence, signal);
      if (this.key !== identity(this.options())) throw new RpcFailure('APP_SERVER_CONTEXT_CHANGED');
      if (pending.size) throw new RpcFailure('APP_SERVER_REQUESTS_PENDING');
      return result;
    } catch (error) {
      const code = signal?.aborted
        ? 'CLIENT_ABORTED'
        : error instanceof RpcFailure
          ? error.code
          : 'HOST_ERROR';
      if (
        !client.usable ||
        code === 'APP_SERVER_CONTEXT_CHANGED' ||
        // A timeout with nobody else on the connection may mean a stuck process.
        (code === 'RESPONSE_TIMEOUT' && this.active <= 1)
      ) {
        await this.retire(client);
        this.failureCode = code;
        if (!this.stopped) this.state = 'failed';
      }
      if (signal?.aborted) throw new RpcFailure('CLIENT_ABORTED');
      throw error;
    } finally {
      live = false;
      await Promise.allSettled([...pending]);
    }
  }
  /** Ends an index cooldown early (the Host finished warming the state index). */
  wake(): void {
    this.retryAfter = 0;
    if (this.state === 'failed') {
      this.state = 'idle';
      this.failureCode = null;
    }
  }
  /**
   * Warm the shared state index before a dedicated execution process starts. Once a connection
   * with the same launch identity initialized under this fence the index is ready, so a Run does
   * not wait behind queued metadata reads (a Codex history listing can take seconds).
   */
  prepare(signal?: AbortSignal): Promise<number> {
    const fence = this.fence;
    try {
      this.check(fence, signal);
      if (
        this.initialized?.fence === fence &&
        !this.limits.blocked?.() &&
        this.initialized.key === identity(this.options())
      )
        return Promise.resolve(fence);
    } catch {
      // Closed, aborted or unavailable: the queued path reports the precise error.
    }
    return this.read(async () => this.fence, signal);
  }
  openDedicated(options: RpcOptions, fence: number): StdioRpcClient {
    this.check(fence, options.signal);
    const client = new StdioRpcClient(options);
    this.children.add(client);
    void client.waitClosed().then(() => this.children.delete(client));
    return client;
  }
  /** A privacy/runtime fence closes live processes before any app-owned cache is removed. */
  async reset(): Promise<void> {
    if (this.resetting) return this.resetting;
    this.fence++;
    const client = this.client;
    this.client = undefined;
    this.key = undefined;
    this.retryAfter = 0;
    this.state = 'closing';
    const waiting = [...this.leases, this.starting?.catch(() => {})],
      children = [...this.children];
    this.resetting = (async () => {
      await Promise.all([client?.close(), ...children.map((child) => child.close())]);
      await Promise.all(waiting);
      this.state = this.stopped ? 'closed' : 'idle';
      this.failureCode = null;
    })();
    try {
      await this.resetting;
    } finally {
      this.resetting = undefined;
    }
  }
  async close(): Promise<void> {
    this.stopped = true;
    await this.reset();
  }
}
