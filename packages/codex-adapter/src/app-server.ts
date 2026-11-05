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
  private tail: Promise<void> = Promise.resolve();
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
  private children = new Set<StdioRpcClient>();
  private options: () => Options;
  private limits: {
    maximumQueue?: number;
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
  private async ready(fence: number, signal?: AbortSignal): Promise<StdioRpcClient> {
    this.check(fence, signal);
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
        this.client.requestCount >= (this.limits.rotateAfterRequests ?? 2048))
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
    const client = new StdioRpcClient(options);
    this.client = client;
    this.key = key;
    this.starts++;
    this.generation++;
    this.state = 'starting';
    const abort = () => {
      void this.retire(client);
    };
    signal?.addEventListener('abort', abort, { once: true });
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
      this.check(fence, signal);
      if (!client.usable) throw new RpcFailure('PROCESS_EXITED');
      this.state = 'ready';
      this.failureCode = null;
      return client;
    } catch (error) {
      await this.retire(client);
      this.failureCode = signal?.aborted
        ? 'CLIENT_ABORTED'
        : error instanceof RpcFailure
          ? error.code
          : 'HOST_ERROR';
      if (this.failureCode === 'CODEX_STATE_INDEX_PENDING') {
        this.retryAfter =
          (this.limits.now ?? Date.now)() + (this.limits.backfillCooldownMs ?? 30000);
        this.key = key;
      }
      if (!this.stopped) this.state = 'failed';
      if (signal?.aborted) throw new RpcFailure('CLIENT_ABORTED');
      throw error;
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  }
  /** Leases are serialized and bounded; a failed operation is never replayed. */
  read<T>(work: (port: ReadPort) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const fence = this.fence;
    try {
      this.check(fence, signal);
      if (this.queue >= (this.limits.maximumQueue ?? 32))
        throw new RpcFailure('APP_SERVER_QUEUE_LIMIT');
    } catch (error) {
      return Promise.reject(error);
    }
    this.queue++;
    const job = this.tail.then(async () => {
      this.check(fence, signal);
      const client = await this.ready(fence, signal);
      let live = true;
      const pending = new Set<Promise<unknown>>();
      const abort = () => {
        void this.retire(client);
      };
      signal?.addEventListener('abort', abort, { once: true });
      const port: ReadPort = {
        request: <R>(method: string, params: unknown): Promise<R> => {
          if (!live) return Promise.reject(new RpcFailure('APP_SERVER_LEASE_EXPIRED'));
          try {
            this.check(fence, signal);
            if (!reads.has(method)) throw new RpcFailure('READ_METHOD_NOT_ALLOWED');
          } catch (error) {
            return Promise.reject(error);
          }
          const request = client.request<R>(method, params);
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
        if (this.key !== identity(this.options()))
          throw new RpcFailure('APP_SERVER_CONTEXT_CHANGED');
        if (pending.size) throw new RpcFailure('APP_SERVER_REQUESTS_PENDING');
        return result;
      } catch (error) {
        await this.retire(client);
        this.failureCode = signal?.aborted
          ? 'CLIENT_ABORTED'
          : error instanceof RpcFailure
            ? error.code
            : 'HOST_ERROR';
        if (!this.stopped) this.state = 'failed';
        if (signal?.aborted) throw new RpcFailure('CLIENT_ABORTED');
        throw error;
      } finally {
        live = false;
        signal?.removeEventListener('abort', abort);
        await Promise.allSettled([...pending]);
      }
    });
    const result = job.finally(() => {
      this.queue--;
    });
    this.tail = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  /** Ends an index cooldown early (the Host finished warming the state index). */
  wake(): void {
    this.retryAfter = 0;
    if (this.state === 'failed') {
      this.state = 'idle';
      this.failureCode = null;
    }
  }
  /** Warm the shared state index before a dedicated execution process starts. */
  prepare(signal?: AbortSignal): Promise<number> {
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
    const waiting = this.tail,
      children = [...this.children];
    this.resetting = (async () => {
      await Promise.all([client?.close(), ...children.map((child) => child.close())]);
      await waiting;
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
