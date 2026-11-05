import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { LedgerError } from '../../store/src/ledger.ts';
import { resolveSystemGit } from './platform.ts';
import { isObject } from '../../codex-adapter/src/rpc.ts';
import { sandboxStdioFiles, sandboxStdioUsesFiles } from '../../codex-adapter/src/sandbox-stdio.ts';
import type { ProjectView } from '../../contracts/src/views.ts';
import type {
  WorkspaceDirectory,
  WorkspaceOverview,
  WorkspacePreview,
  WorkspaceDiff,
  WorkspaceGit,
} from '../../contracts/src/workspace.ts';
const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const identity = (path: string) => {
  const s = lstatSync(path, { bigint: true });
  return [String(s.dev), String(s.ino), String(s.mode), String(s.size), String(s.mtimeNs)].join(
    ':',
  );
};
const validId = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= 200 && !/[\x00-\x1f]/.test(v);
const fail = (code: string): never => {
  throw new LedgerError(code);
};
function query(value: unknown, keys: string[]): Record<string, string> {
  if (
    !isObject(value) ||
    Object.keys(value).length !== keys.length ||
    Object.keys(value).some((k) => !keys.includes(k)) ||
    keys.some((k) => !Object.hasOwn(value, k) || !validId(value[k]))
  )
    return fail('INVALID_WORKSPACE_QUERY');
  return value as Record<string, string>;
}
export interface WorkspaceReaderOptions {
  managedGit?: (workspaceId: string) => {
    gitDir: string;
    commonDir: string;
    gitIdentity: { device: string; inode: string };
    commonIdentity: { device: string; inode: string };
  } | null;
  node: string;
  cli: string;
  git: string;
  worker: string;
  stateDirectory: string;
  timeoutMs?: number;
  /** Component tests only. Never supplied over IPC. */ withoutSandboxForTests?: boolean;
}
interface Handle {
  projectId: string;
  path: string;
  identity: string | null;
  kind: 'directory' | 'file' | 'change';
  gitToken?: string;
  staged?: string;
  unstaged?: string;
  untracked?: boolean;
  rootIdentity: string;
}
/** macOS: xcrun git; Linux: first system git (see platform.ts). */
export function resolveWorkspaceGit(): string {
  return resolveSystemGit();
}
/** Workspace-scoped observation service; it cannot write source files or dispatch model/terminal requests. */
export class WorkspaceService {
  private workspace: (id: string) => ProjectView;
  private options: WorkspaceReaderOptions;
  private program: string;
  private programHash: string;
  private handles = new Map<string, Handle>();
  /** Reads run one at a time (one sandboxed process each); later callers wait their turn. */
  private queue: Promise<unknown> = Promise.resolve();
  private waiting = 0;
  constructor(workspace: (id: string) => ProjectView, options: WorkspaceReaderOptions) {
    this.workspace = workspace;
    this.options = options;
    mkdirSync(options.stateDirectory, { recursive: true, mode: 0o700 });
    const bytes = readFileSync(options.worker);
    this.programHash = hash(bytes);
    this.program = join(options.stateDirectory, `reader-${this.programHash}.mjs`);
    if (existsSync(this.program)) {
      if (
        lstatSync(this.program).isSymbolicLink() ||
        hash(readFileSync(this.program)) !== this.programHash
      )
        fail('WORKSPACE_READER_CHANGED');
    } else writeFileSync(this.program, bytes, { mode: 0o400, flag: 'wx' });
  }
  private handle(projectId: string, id: string, kind?: Handle['kind']): Handle {
    const h = this.handles.get(id);
    if (!h || h.projectId !== projectId || (kind && h.kind !== kind))
      return fail('WORKSPACE_ENTRY_NOT_GRANTED');
    const project = this.workspace(projectId);
    if (identity(project.directory).split(':').slice(0, 2).join(':') !== h.rootIdentity)
      return fail('PROJECT_IDENTITY_CHANGED');
    return h;
  }
  private issue(
    project: ProjectView,
    path: string,
    stamp: string | null,
    kind: Handle['kind'],
    extra: Partial<Handle> = {},
  ): string {
    if (this.handles.size >= 4096) return fail('WORKSPACE_NAVIGATION_LIMIT');
    const id = randomUUID();
    this.handles.set(id, {
      projectId: project.id,
      path,
      identity: stamp,
      kind,
      rootIdentity: identity(project.directory).split(':').slice(0, 2).join(':'),
      ...extra,
    });
    return id;
  }
  private directory(
    project: ProjectView,
    path: string,
    data: Record<string, unknown>,
  ): WorkspaceDirectory {
    if (!Array.isArray(data.entries) || data.entries.length > 200)
      return fail('INVALID_WORKSPACE_RESPONSE');
    const parts = path.split('/').filter(Boolean),
      breadcrumbs = [
        {
          id: this.issue(project, '', identity(project.directory), 'directory'),
          name: project.name,
        },
      ];
    for (let n = 0; n < parts.length; n++) {
      const part = parts.slice(0, n + 1).join('/');
      breadcrumbs.push({
        id: this.issue(
          project,
          part,
          identity(join(project.directory, ...parts.slice(0, n + 1))),
          'directory',
        ),
        name: parts[n]!,
      });
    }
    return {
      version: 1,
      projectId: project.id,
      path,
      breadcrumbs,
      entries: data.entries.map((entry) => {
        if (
          !isObject(entry) ||
          typeof entry.path !== 'string' ||
          typeof entry.name !== 'string' ||
          !['directory', 'file', 'blocked'].includes(String(entry.kind)) ||
          typeof entry.identity !== 'string' ||
          typeof entry.size !== 'number'
        )
          return fail('INVALID_WORKSPACE_RESPONSE');
        return {
          id:
            entry.kind === 'blocked'
              ? null
              : this.issue(project, entry.path, entry.identity, entry.kind as 'directory' | 'file'),
          name: entry.name,
          path: entry.path,
          kind: entry.kind as 'directory' | 'file' | 'blocked',
          size: entry.size,
          ...(typeof entry.reason === 'string' ? { reason: entry.reason } : {}),
        };
      }),
      truncated: data.truncated === true,
    };
  }
  async overview(input: unknown, signal?: AbortSignal): Promise<WorkspaceOverview> {
    const q = query(input, ['projectId']),
      project = this.workspace(q.projectId!);
    const data = await this.read(
      project,
      { operation: 'overview', path: '', identity: identity(project.directory) },
      signal,
    );
    for (const [id, h] of this.handles) {
      if (h.projectId === project.id) this.handles.delete(id);
    }
    if (
      !isObject(data.directory) ||
      !isObject(data.git) ||
      !Array.isArray(data.git.changes) ||
      data.git.changes.length > 500
    )
      return fail('INVALID_WORKSPACE_RESPONSE');
    const raw = data.git,
      git: WorkspaceGit = {
        available: raw.available === true,
        branch: typeof raw.branch === 'string' ? raw.branch : null,
        head: typeof raw.head === 'string' ? raw.head : null,
        changes: [],
        ...(typeof raw.reason === 'string' ? { reason: raw.reason } : {}),
      };
    if (git.available) {
      if (typeof raw.token !== 'string' || !Array.isArray(raw.changes))
        return fail('INVALID_WORKSPACE_RESPONSE');
      git.changes = raw.changes.map((value: unknown) => {
        if (
          !isObject(value) ||
          typeof value.path !== 'string' ||
          typeof value.staged !== 'string' ||
          typeof value.unstaged !== 'string'
        )
          return fail('INVALID_WORKSPACE_RESPONSE');
        return {
          id:
            typeof value.reason === 'string'
              ? null
              : this.issue(
                  project,
                  value.path,
                  typeof value.fileIdentity === 'string' ? value.fileIdentity : null,
                  'change',
                  {
                    gitToken: String(raw.token),
                    staged: value.staged,
                    unstaged: value.unstaged,
                    untracked: value.untracked === true,
                  },
                ),
          path: value.path,
          ...(typeof value.previousPath === 'string' ? { previousPath: value.previousPath } : {}),
          staged: value.staged,
          unstaged: value.unstaged,
          untracked: value.untracked === true,
          conflict: value.conflict === true,
          ...(typeof value.reason === 'string' ? { reason: value.reason } : {}),
        };
      });
    }
    return {
      version: 1,
      projectId: project.id,
      directory: this.directory(project, '', data.directory),
      git,
      observedAt: new Date().toISOString(),
    };
  }
  async list(input: unknown, signal?: AbortSignal): Promise<WorkspaceDirectory> {
    const q = query(input, ['projectId', 'entryId']),
      handle = this.handle(q.projectId!, q.entryId!, 'directory'),
      project = this.workspace(q.projectId!);
    return this.directory(
      project,
      handle.path,
      await this.read(
        project,
        { operation: 'list', path: handle.path, identity: handle.identity },
        signal,
      ),
    );
  }
  async preview(input: unknown, signal?: AbortSignal): Promise<WorkspacePreview> {
    const q = query(input, ['projectId', 'entryId']),
      h = this.handle(q.projectId!, q.entryId!, 'file'),
      project = this.workspace(q.projectId!);
    const data = await this.read(
      project,
      { operation: 'preview', path: h.path, identity: h.identity },
      signal,
    );
    if (
      !['text', 'binary', 'tooLarge'].includes(String(data.kind)) ||
      typeof data.text !== 'string' ||
      data.text.length > 131072 ||
      typeof data.bytes !== 'number'
    )
      return fail('INVALID_WORKSPACE_RESPONSE');
    return {
      version: 1,
      projectId: project.id,
      path: h.path,
      kind: data.kind as WorkspacePreview['kind'],
      text: data.text,
      bytes: data.bytes,
      contentHash: typeof data.contentHash === 'string' ? data.contentHash : null,
    };
  }
  async diff(input: unknown, signal?: AbortSignal): Promise<WorkspaceDiff> {
    const q = query(input, ['projectId', 'changeId', 'part']);
    if (!['staged', 'unstaged'].includes(q.part!)) return fail('INVALID_WORKSPACE_QUERY');
    const h = this.handle(q.projectId!, q.changeId!, 'change'),
      project = this.workspace(q.projectId!);
    if (
      h.untracked ||
      (q.part === 'staged' && h.staged === '.') ||
      (q.part === 'unstaged' && h.unstaged === '.')
    )
      return fail('WORKSPACE_DIFF_UNAVAILABLE');
    const data = await this.read(
      project,
      { operation: 'diff', path: h.path, identity: h.identity, gitToken: h.gitToken, part: q.part },
      signal,
    );
    if (typeof data.text !== 'string' || data.text.length > 262144)
      return fail('INVALID_WORKSPACE_RESPONSE');
    return {
      version: 1,
      projectId: project.id,
      path: h.path,
      part: q.part as 'staged' | 'unstaged',
      text: data.text,
      empty: !data.text,
    };
  }
  private read(
    project: ProjectView,
    operation: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    if (this.waiting >= 8) return Promise.reject(new LedgerError('WORKSPACE_READ_BUSY'));
    this.waiting++;
    const run = this.queue.then(() => {
      this.waiting--;
      if (signal?.aborted) return fail('WORKSPACE_READ_INTERRUPTED');
      return this.readNow(project, operation, signal);
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
  private async readNow(
    project: ProjectView,
    operation: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    let scratchRoot: string | undefined;
    try {
      if (hash(readFileSync(this.program)) !== this.programHash)
        return fail('WORKSPACE_READER_CHANGED');
      this.workspace(project.id);
      const rootStamp = identity(project.directory);
      scratchRoot = mkdtempSync(join(this.options.stateDirectory, 'query-'));
      const home = join(scratchRoot, 'home'),
        scratch = join(scratchRoot, 'scratch');
      mkdirSync(home, { mode: 0o700 });
      mkdirSync(scratch, { mode: 0o700 });
      const managedGit = this.options.managedGit?.(project.id),
        readRoots = [
          dirname(dirname(this.options.node)),
          dirname(dirname(this.options.git)),
          dirname(this.program),
          ...(managedGit ? [managedGit.gitDir, managedGit.commonDir] : []),
        ];
      if (process.platform === 'darwin' && existsSync('/System/Library/OpenSSL'))
        readRoots.push(realpathSync('/System/Library/OpenSSL'));
      // Linux: bubblewrap re-executes the Codex binary as its codex-linux-sandbox helper inside the restricted view.
      if (process.platform === 'linux' && !this.options.withoutSandboxForTests)
        readRoots.push(this.options.cli);
      const protectedRoots = new Set([
        '.codex',
        '.agents',
        '.aws',
        '.ssh',
        '.kube',
        '.local',
        '.npmrc',
        '.netrc',
        '.pypirc',
        'credentials.json',
        'auth.json',
        ...(operation.operation === 'overview' || operation.operation === 'diff' ? [] : ['.git']),
      ]);
      for (const name of readdirSync(project.directory)) {
        const lower = name.toLowerCase();
        if (
          protectedRoots.has(lower) ||
          lower === '.env' ||
          lower.startsWith('.env.') ||
          /\.(pem|key|p12|pfx)$/.test(lower)
        )
          protectedRoots.add(name);
      }
      const config =
        '[permissions.personal-agent-workspace]\nextends=":read-only"\n[permissions.personal-agent-workspace.filesystem]\n":root"="deny"\n":minimal"="read"\n' +
        readRoots.map((p) => `${JSON.stringify(p)}="read"\n`).join('') +
        `${JSON.stringify(scratch)}="write"\n` +
        [...protectedRoots]
          .map((name) => `${JSON.stringify(join(project.directory, name))}="deny"\n`)
          .join('') +
        '[permissions.personal-agent-workspace.filesystem.":workspace_roots"]\n"."="read"\n[permissions.personal-agent-workspace.network]\nenabled=false\n';
      writeFileSync(join(home, 'config.toml'), config, { mode: 0o600 });
      const args = this.options.withoutSandboxForTests
        ? [this.program]
        : [
            'sandbox',
            '--include-managed-config',
            '--permission-profile',
            'personal-agent-workspace',
            '-C',
            project.directory,
            '--',
            this.options.node,
            this.program,
          ];
      const request = JSON.stringify({
        ...operation,
        directory: project.directory,
        rootIdentity: rootStamp,
        git: this.options.git,
        managedGit,
      });
      const files =
        sandboxStdioUsesFiles && !this.options.withoutSandboxForTests
          ? sandboxStdioFiles(scratchRoot, request)
          : undefined;
      const child = spawn(
        this.options.withoutSandboxForTests ? this.options.node : this.options.cli,
        args,
        {
          cwd: project.directory,
          env: {
            PATH: process.env.PATH,
            HOME: home,
            CODEX_HOME: home,
            TMPDIR: scratch,
            LANG: 'en_US.UTF-8',
            TZ: 'UTC',
          },
          stdio: files ? files.stdio : ['pipe', 'pipe', 'pipe'],
          detached: process.platform !== 'win32',
        },
      );
      let bytes = 0,
        stopped = false;
      const chunks: Buffer[] = [];
      const stop = () => {
        stopped = true;
        try {
          if (child.pid) {
            if (process.platform === 'win32') child.kill('SIGKILL');
            else process.kill(-child.pid, 'SIGKILL');
          }
        } catch {}
      };
      const timer = setTimeout(stop, this.options.timeoutMs ?? 12000);
      signal?.addEventListener('abort', stop, { once: true });
      if (signal?.aborted) stop();
      child.stdout?.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > 1048576) {
          stop();
          return;
        }
        chunks.push(chunk);
      });
      child.stderr?.on('data', () => {});
      child.stdin?.on('error', () => {});
      child.stdin?.end(request);
      let code: number | null;
      try {
        code = await new Promise<number | null>((done) => {
          child.once('error', () => done(null));
          child.once('close', done);
        });
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', stop);
        files?.close();
      }
      if (files) {
        const output = files.output(1048576);
        if (output === null) stopped = true;
        else chunks.push(output);
      }
      if (stopped || code === null) return fail('WORKSPACE_READ_INTERRUPTED');
      this.workspace(project.id);
      if (identity(project.directory) !== rootStamp) return fail('WORKSPACE_IDENTITY_CHANGED');
      let result: unknown;
      try {
        result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return fail('INVALID_WORKSPACE_RESPONSE');
      }
      if (!isObject(result)) return fail('INVALID_WORKSPACE_RESPONSE');
      if (result.ok !== true)
        return fail(
          typeof result.code === 'string' && /^[A-Z_]+$/.test(result.code)
            ? result.code
            : 'WORKSPACE_READ_FAILED',
        );
      if (code !== 0 || !isObject(result.data)) return fail('WORKSPACE_READ_FAILED');
      return result.data;
    } finally {
      if (scratchRoot) rmSync(scratchRoot, { recursive: true, force: true });
    }
  }
}
