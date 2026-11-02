import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

type JsonObject = Record<string, unknown>;
type RequestId = string | number;
type Pending = { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout };
export const isObject = (value: unknown): value is JsonObject =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export class RpcFailure extends Error {
  readonly code: string;
  readonly outcomeUnknown: boolean;
  readonly details?: Record<string, unknown>;
  constructor(code: string, outcomeUnknown = false, details?: Record<string, unknown>) {
    super(code);
    this.name = 'RpcFailure';
    this.code = code;
    this.outcomeUnknown = outcomeUnknown;
    this.details = details;
  }
}

export interface RpcOptions {
  executable: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  maximumFrameBytes?: number;
  signal?: AbortSignal;
  onNotification?(message: JsonObject): void;
  /** Trusted Host diagnostics only. Consumers must classify/redact before persisting any field. */
  onRemoteError?(error: unknown): void;
  onServerRequest?(message: JsonObject): Promise<unknown>;
}

/** Trusted Host transport. Never expose request() or executable selection over Renderer IPC. */
export class StdioRpcClient {
  private child: ChildProcessWithoutNullStreams;
  private pending = new Map<RequestId, Pending>();
  private nextId = 1;
  private buffer = Buffer.alloc(0);
  private closed = false;
  private exited = false;
  private stopRequested = false;
  private options: RpcOptions;
  private exitPromise: Promise<void>;
  private serverRequests = new Set<RequestId>();

  constructor(options: RpcOptions) {
    this.options = options;
    this.child = spawn(options.executable, options.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: options.env,
      detached: process.platform !== 'win32',
    });
    this.exitPromise = new Promise(resolve => {
      this.child.once('close', () => { this.exited = true; this.fail(new RpcFailure('PROCESS_EXITED', true)); resolve(); });
      this.child.once('error', () => { this.exited = true; this.fail(new RpcFailure('SPAWN_FAILED')); resolve(); });
    });
    this.child.stdout.on('data', (chunk: Buffer) => this.receive(chunk));
    // stderr is intentionally drained without copying arbitrary private diagnostics into UI or logs.
    this.child.stderr.on('data', () => {});
    this.child.stdin.on('error', () => this.fail(new RpcFailure('TRANSPORT_CLOSED', true)));
    options.signal?.addEventListener('abort', this.abort, { once: true });
    if (options.signal?.aborted) this.abort();
  }

  private abort = (): void => { this.fail(new RpcFailure('CLIENT_ABORTED', true)); this.signal('SIGTERM'); };

  waitClosed(): Promise<void> { return this.exitPromise; }

  request<T = unknown>(method: string, params: unknown, timeoutMs = this.options.requestTimeoutMs ?? 15_000): Promise<T> {
    if (this.closed || this.stopRequested) return Promise.reject(new RpcFailure('DISCONNECTED'));
    if (this.pending.size >= 32) return Promise.reject(new RpcFailure('PENDING_LIMIT'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcFailure('RESPONSE_TIMEOUT', true));
      }, timeoutMs);
      this.pending.set(id, { resolve: value => resolve(value as T), reject, timer });
      void this.write({ id, method, params }).catch(() => this.fail(new RpcFailure('WRITE_FAILED', true)));
    });
  }

  async notify(method: string, params: unknown = {}): Promise<void> {
    await this.write({ method, params });
  }

  private write(message: JsonObject): Promise<void> {
    if (this.closed || !this.child.stdin.writable) return Promise.reject(new RpcFailure('DISCONNECTED'));
    return new Promise((resolve, reject) => {
      this.child.stdin.write(JSON.stringify(message) + '\n', error => error ? reject(error) : resolve());
    });
  }

  private receive(chunk: Buffer): void {
    if (this.closed) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const maximum = this.options.maximumFrameBytes ?? 1_048_576;
    let newline: number;
    while ((newline = this.buffer.indexOf(10)) >= 0) {
      if (newline > maximum) return this.protocolFailure('FRAME_TOO_LARGE');
      const frame = this.buffer.subarray(0, newline);
      this.buffer = this.buffer.subarray(newline + 1);
      if (frame.length === 0) continue;
      try {
        const decoded: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(frame));
        if (!isObject(decoded)) return this.protocolFailure('INVALID_ENVELOPE');
        this.dispatch(decoded);
      } catch { return this.protocolFailure('INVALID_JSON_FRAME'); }
    }
    if (this.buffer.length > maximum) this.protocolFailure('FRAME_TOO_LARGE');
  }

  private dispatch(message: JsonObject): void {
    const id = message.id;
    const validId = typeof id === 'string' || (typeof id === 'number' && Number.isSafeInteger(id));
    if (typeof message.method === 'string') {
      if (id === undefined) {
        // Consumer failures are not protocol errors and must not corrupt the transport.
        try { this.options.onNotification?.(message); } catch {}
      } else if (validId) {
        if (this.serverRequests.size >= 32) return this.protocolFailure('SERVER_REQUEST_LIMIT');
        if (this.serverRequests.has(id)) return this.protocolFailure('DUPLICATE_SERVER_REQUEST');
        this.serverRequests.add(id);
        void this.answerServerRequest(id, message);
      } else this.protocolFailure('INVALID_REQUEST_ID');
      return;
    }
    if (!validId || (('result' in message) === ('error' in message))) return this.protocolFailure('INVALID_RESPONSE');
    const pending = this.pending.get(id);
    if (!pending) return; // A response after its deadline is never treated as permission to retry.
    clearTimeout(pending.timer);
    this.pending.delete(id);
    if ('error' in message) {
      try { this.options.onRemoteError?.(message.error); } catch {}
      const code = isObject(message.error) && typeof message.error.code === 'number' ? message.error.code : 'UNKNOWN';
      pending.reject(new RpcFailure(`REMOTE_${code}`));
    } else pending.resolve(message.result);
  }

  private async answerServerRequest(id: RequestId, request: JsonObject): Promise<void> {
    try {
      if (!this.options.onServerRequest) {
        await this.write({ id, error: { code: -32601, message: 'Unsupported server request; execution remains blocked' } });
      } else {
        const result = await this.options.onServerRequest(request);
        await this.write({ id, result });
      }
    } catch {
      await this.write({ id, error: { code: -32603, message: 'Host rejected server request' } }).catch(() => {});
    } finally { this.serverRequests.delete(id); }
  }

  private protocolFailure(code: string): void {
    this.fail(new RpcFailure(code, true));
    this.signal('SIGTERM');
  }

  private fail(error: RpcFailure): void {
    if (this.closed) return;
    this.closed = true;
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); }
    this.pending.clear();
  }

  private signal(signal: NodeJS.Signals): void {
    const pid = this.child.pid;
    if (!pid || this.exited) return;
    try {
      if (process.platform === 'win32') this.child.kill(signal);
      else process.kill(-pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }

  async close(): Promise<void> {
    if (this.stopRequested) return this.exitPromise;
    this.stopRequested = true;
    this.fail(new RpcFailure('CLIENT_CLOSED', true));
    this.child.stdin.end();
    const terminate = setTimeout(() => this.signal('SIGTERM'), 1_000);
    const kill = setTimeout(() => this.signal('SIGKILL'), 3_000);
    try { await this.exitPromise; }
    finally { clearTimeout(terminate); clearTimeout(kill); this.options.signal?.removeEventListener('abort', this.abort); }
  }
}
