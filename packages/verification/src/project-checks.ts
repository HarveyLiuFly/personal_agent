import { spawn } from 'node:child_process';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { LedgerError } from '../../store/src/ledger.ts';
import type { ExecutionLedger } from '../../store/src/ledger.ts';
import type { ProjectCheckSetting, ProjectCheckView } from '../../contracts/src/conversations.ts';

/** A project's check command ("项目检查命令"): an argv run without a shell. */
export interface ProjectCheckConfig {
  argv: string[];
  label: string;
  /** Run after each turn of this project that could write files. */
  autoRun: boolean;
}
export interface CheckPreset {
  id: string;
  label: string;
  argv: string[];
}
export const CHECK_PRESETS: readonly CheckPreset[] = [
  { id: 'npm', label: 'npm test', argv: ['npm', 'test'] },
  { id: 'pnpm', label: 'pnpm test', argv: ['pnpm', 'test'] },
  { id: 'node', label: 'node --test（Node 内置测试）', argv: ['node', '--test'] },
  { id: 'pytest', label: 'pytest', argv: ['python3', '-m', 'pytest'] },
  { id: 'go', label: 'go test ./...', argv: ['go', 'test', './...'] },
  { id: 'cargo', label: 'cargo test', argv: ['cargo', 'test'] },
  { id: 'make', label: 'make test', argv: ['make', 'test'] },
];
export interface CheckResult {
  status: 'passed' | 'failed' | 'timeout' | 'error';
  exitCode: number | null;
  durationMs: number;
  /** The end of stdout and stderr together. */
  output: string;
  outputTruncated: boolean;
}

const fail = (code: string): never => {
  throw new LedgerError(code);
};
/** Each argument: 1–1000 characters, no control characters; 1–32 arguments. */
export function validArgv(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > 32 ||
    value.some(
      (arg) =>
        typeof arg !== 'string' || !arg.length || arg.length > 1000 || /[\x00-\x1f]/.test(arg),
    )
  )
    return fail('INVALID_CHECK_COMMAND');
  return value as string[];
}
/**
 * Splits a typed command line into arguments (single and double quotes group words). There is
 * no shell: pipes, redirections, `;`, `&&` and `$` substitutions are refused instead of being
 * passed on literally.
 */
export function parseCommandLine(line: string): string[] {
  if (typeof line !== 'string' || line.length > 4000) return fail('INVALID_CHECK_COMMAND');
  const args: string[] = [];
  let current = '',
    quote: '"' | "'" | null = null,
    started = false;
  for (const char of line) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) args.push(current);
      current = '';
      started = false;
    } else if (/[|&;<>`$()]/.test(char)) return fail('CHECK_COMMAND_NEEDS_NO_SHELL');
    else {
      current += char;
      started = true;
    }
  }
  if (quote) return fail('INVALID_CHECK_COMMAND');
  if (started) args.push(current);
  return validArgv(args);
}

/** Per-project check commands in one private JSON file (`userData/project-checks.json`). */
export class ProjectCheckStore {
  private file: string;
  constructor(file: string) {
    this.file = file;
  }
  private read(): Record<string, ProjectCheckConfig> {
    if (!existsSync(this.file)) return {};
    try {
      const data = JSON.parse(readFileSync(this.file, 'utf8'));
      return data && data.version === 1 && data.projects && typeof data.projects === 'object'
        ? data.projects
        : {};
    } catch {
      return {};
    }
  }
  get(projectId: string): ProjectCheckConfig | null {
    const config = this.read()[projectId];
    if (!config) return null;
    try {
      return {
        argv: validArgv(config.argv),
        label: String(config.label ?? '').slice(0, 200) || config.argv.join(' '),
        autoRun: config.autoRun === true,
      };
    } catch {
      return null;
    }
  }
  set(projectId: string, config: ProjectCheckConfig | null): void {
    const projects = this.read();
    if (config)
      projects[projectId] = {
        argv: validArgv(config.argv),
        label: String(config.label).slice(0, 200) || config.argv.join(' '),
        autoRun: config.autoRun === true,
      };
    else delete projects[projectId];
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify({ version: 1, projects }, null, 2) + '\n', {
      mode: 0o600,
    });
    renameSync(temporary, this.file);
  }
}

const OUTPUT_TAIL = 16_384;
/**
 * Runs the check in the Codex sandbox (`codex sandbox -P`): the whole file system readable, only
 * the workspace and a private scratch directory writable, no network. Output goes to a private
 * file (Linux sandbox stdio pipes are unreliable) and only its end is kept.
 */
export async function runProjectCheck(options: {
  cli: string;
  cwd: string;
  argv: string[];
  stateDirectory: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<CheckResult> {
  const argv = validArgv(options.argv);
  mkdirSync(options.stateDirectory, { recursive: true, mode: 0o700 });
  const root = mkdtempSync(join(options.stateDirectory, 'check-')),
    home = join(root, 'codex-home'),
    scratch = join(root, 'scratch');
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(scratch, { mode: 0o700 });
  writeFileSync(
    join(home, 'config.toml'),
    '[permissions.personal-agent-check]\nextends=":read-only"\n' +
      '[permissions.personal-agent-check.filesystem]\n":root"="read"\n' +
      `${JSON.stringify(scratch)}="write"\n` +
      '[permissions.personal-agent-check.filesystem.":workspace_roots"]\n"."="write"\n' +
      '[permissions.personal-agent-check.network]\nenabled=false\n',
    { mode: 0o600 },
  );
  const outputPath = join(root, 'output');
  const output = openSync(
    outputPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  const environment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LANG: process.env.LANG ?? 'en_US.UTF-8',
    TERM: 'dumb',
    CI: '1',
    CODEX_HOME: home,
    TMPDIR: scratch,
    XDG_CACHE_HOME: join(scratch, 'cache'),
    GOCACHE: join(scratch, 'go-build'),
    npm_config_cache: join(scratch, 'npm'),
    PYTHONDONTWRITEBYTECODE: '1',
  };
  const begun = Date.now();
  const child = spawn(
    options.cli,
    [
      'sandbox',
      '--include-managed-config',
      '--permission-profile',
      'personal-agent-check',
      '-C',
      options.cwd,
      '--',
      ...argv,
    ],
    {
      cwd: options.cwd,
      env: environment,
      stdio: ['ignore', output, output],
      detached: process.platform !== 'win32',
    },
  );
  let timedOut = false;
  const kill = () => {
    timedOut = true;
    try {
      if (child.pid) {
        if (process.platform === 'win32') child.kill('SIGKILL');
        else process.kill(-child.pid, 'SIGKILL');
      }
    } catch {
      // Already gone.
    }
  };
  options.signal?.addEventListener('abort', kill, { once: true });
  if (options.signal?.aborted) kill();
  const timer = setTimeout(kill, options.timeoutMs ?? 600_000);
  try {
    const exitCode = await new Promise<number | null>((done) => {
      child.once('error', () => done(null));
      child.once('close', (code) => done(code));
    });
    closeSync(output);
    const tail = readTail(outputPath, OUTPUT_TAIL);
    return {
      status: timedOut
        ? 'timeout'
        : exitCode === null
          ? 'error'
          : exitCode === 0
            ? 'passed'
            : 'failed',
      exitCode,
      durationMs: Date.now() - begun,
      output: tail.text,
      outputTruncated: tail.truncated,
    };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', kill);
    try {
      closeSync(output);
    } catch {
      // Closed above.
    }
    rmSync(root, { recursive: true, force: true });
  }
}
function readTail(path: string, limit: number): { text: string; truncated: boolean } {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const size = fstatSync(fd).size,
      length = Math.min(size, limit),
      buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    let text = buffer.toString('utf8');
    if (size > limit) text = text.replace(/^[^\n]*\n?/, '');
    return { text, truncated: size > limit };
  } finally {
    closeSync(fd);
  }
}

type Ledger = Pick<
  ExecutionLedger,
  'workspace' | 'runForHost' | 'recordProjectCheck' | 'projectChecks' | 'conversationSummary'
>;
/**
 * The project check command for the window: its setting, on-demand runs (one at a time per
 * project) and the automatic run after a turn that could write files.
 */
export class ProjectCheckService {
  private store: Ledger;
  private configs: ProjectCheckStore;
  private options: {
    cli: () => string;
    stateDirectory: string;
    run?: typeof runProjectCheck;
    onError?: (error: unknown) => void;
  };
  private running = new Set<string>();
  constructor(store: Ledger, configs: ProjectCheckStore, options: ProjectCheckService['options']) {
    this.store = store;
    this.configs = configs;
    this.options = options;
  }
  setting(projectId: string): ProjectCheckSetting {
    this.store.workspace(projectId);
    return { config: this.configs.get(projectId), presets: [...CHECK_PRESETS] };
  }
  /** `preset` or a typed `command`; `remove` clears the setting. */
  configure(input: unknown): ProjectCheckSetting {
    const q = input as Record<string, unknown>;
    if (
      !q ||
      typeof q !== 'object' ||
      Object.keys(q).some(
        (key) => !['projectId', 'preset', 'command', 'autoRun', 'remove'].includes(key),
      ) ||
      typeof q.projectId !== 'string'
    )
      return fail('INVALID_CHECK_SETTING');
    this.store.workspace(q.projectId);
    if (q.remove === true) this.configs.set(q.projectId, null);
    else {
      const preset = CHECK_PRESETS.find((option) => option.id === q.preset);
      const argv = preset
        ? preset.argv
        : typeof q.command === 'string'
          ? parseCommandLine(q.command)
          : fail('INVALID_CHECK_SETTING');
      this.configs.set(q.projectId, {
        argv,
        label: preset?.label ?? argv.join(' '),
        autoRun: q.autoRun === true,
      });
    }
    return this.setting(q.projectId);
  }
  list(input: unknown): ProjectCheckView[] {
    const q = input as { projectId?: unknown; conversationId?: unknown };
    if (typeof q?.projectId !== 'string' || typeof q.conversationId !== 'string')
      return fail('INVALID_CHECK_QUERY');
    return this.store.projectChecks(q.projectId, q.conversationId);
  }
  async run(input: unknown, automatic = false): Promise<ProjectCheckView> {
    const q = input as { projectId?: unknown; conversationId?: unknown };
    if (
      typeof q?.projectId !== 'string' ||
      typeof q.conversationId !== 'string' ||
      Object.keys(q).length !== 2
    )
      return fail('INVALID_CHECK_QUERY');
    const projectId = q.projectId,
      conversationId = q.conversationId;
    this.store.conversationSummary({ projectId, conversationId });
    const config = this.configs.get(projectId);
    if (!config) return fail('CHECK_NOT_CONFIGURED');
    if (this.running.has(projectId)) return fail('CHECK_RUNNING');
    this.running.add(projectId);
    try {
      const result = await (this.options.run ?? runProjectCheck)({
        cli: this.options.cli(),
        cwd: this.store.workspace(projectId).directory,
        argv: config.argv,
        stateDirectory: this.options.stateDirectory,
      });
      return this.store.recordProjectCheck(projectId, conversationId, {
        label: config.label,
        ...result,
        automatic,
      });
    } finally {
      this.running.delete(projectId);
    }
  }
  /** After a turn ends: runs the check when the project asks for it and the turn could write. */
  afterTurn(runId: string): void {
    try {
      const run = this.store.runForHost(runId);
      if (run.status !== 'completed' || run.mode !== 'workspaceWrite') return;
      if (!this.configs.get(run.workspaceId)?.autoRun) return;
      void this.run({ projectId: run.workspaceId, conversationId: run.taskId }, true).catch(
        (error: unknown) => this.options.onError?.(error),
      );
    } catch (error) {
      this.options.onError?.(error);
    }
  }
}
