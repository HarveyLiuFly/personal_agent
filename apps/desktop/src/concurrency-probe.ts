import type { App, BrowserWindow } from 'electron';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ForegroundExecution } from '../../../packages/runtime/src/execution.ts';
import type { DesktopApi } from './bridge.ts';
import { evidenceDir } from './evidence.ts';

export const CONCURRENCY_EVIDENCE = 'CORE.1-concurrency-desktop';

/**
 * CORE.1 acceptance (A7, A14): two projects each run one real model turn at the same time while
 * the window keeps browsing files, reading a Diff, listing history and checking the connection.
 */
export function createConcurrencyProjects(): string[] {
  return ['alpha', 'beta'].map((name, index) => {
    const directory = realpathSync(
      mkdtempSync(join(tmpdir(), `personal-agent-concurrency-${name}-`)),
    );
    writeFileSync(
      join(directory, 'README.md'),
      `# Project ${name}\n\nA tiny fixture project named ${name} for a concurrency check.\n`,
    );
    writeFileSync(join(directory, 'notes.txt'), 'first line\n');
    const git = (args: string[]) =>
      execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', directory, ...args], {
        stdio: 'ignore',
      });
    git(['init', '--quiet']);
    git(['add', '.']);
    git([
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '--quiet',
      '--no-gpg-sign',
      '-m',
      'fixture',
    ]);
    // An unstaged change so the second project has a Diff to read during the runs.
    if (index === 1) writeFileSync(join(directory, 'notes.txt'), 'first line\nsecond line\n');
    return directory;
  });
}

interface ProbeInput {
  prompts: [string, string];
  connectMs: number;
  runMs: number;
}
type Outcome = { ok: boolean; errorCode?: string };

/** Runs in the sandboxed renderer through the public preload API only; serialized with toString. */
async function rendererProbe(input: ProbeInput) {
  const api = (window as unknown as { personalAgent: DesktopApi }).personalAgent;
  const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
  const started = Date.now();
  let connection = await api.inspect(),
    indexObserved = Boolean(connection.index);
  while (connection.status !== 'connected') {
    if (Date.now() - started > input.connectMs)
      return { stage: 'connect', errorCode: connection.errorCode ?? 'NOT_CONNECTED' };
    await sleep(1000);
    connection = await api.inspect();
    indexObserved ||= Boolean(connection.index);
  }
  const connectMs = Date.now() - started;
  const projects: string[] = [];
  for (let n = 0; n < 2; n++) {
    const chosen = await api.chooseProject();
    if (!chosen.ok || !chosen.value)
      return { stage: 'project', errorCode: chosen.ok ? 'NO_PROJECT' : chosen.errorCode };
    projects.push(chosen.value.id);
  }
  const [alpha, beta] = projects as [string, string];
  const first = await api.getWorkspace({ projectId: alpha }),
    second = await api.getWorkspace({ projectId: beta });
  if (!first.ok || !second.ok) return { stage: 'workspace' };
  const rootId = first.value.directory.breadcrumbs[0]?.id,
    readmeId = first.value.directory.entries.find((entry) => entry.name === 'README.md')?.id,
    noteChange = (overview: typeof second.value) =>
      overview.git.changes.find((change) => change.path === 'notes.txt')?.id ?? undefined;
  const initialChange = noteChange(second.value);
  if (!rootId || !readmeId || !initialChange)
    return { stage: 'workspace', errorCode: 'FIXTURE_ENTRY' };
  let changeId: string = initialChange;

  const reads: Record<
    string,
    { ok: number; failed: Record<string, number>; maxMs: number; totalMs: number }
  > = {};
  let busy = 0,
    rounds = 0,
    bothRunningRounds = 0,
    declined = 0;
  const record = (name: string, result: Outcome, ms: number) => {
    const entry = (reads[name] ??= { ok: 0, failed: {}, maxMs: 0, totalMs: 0 });
    entry.maxMs = Math.max(entry.maxMs, ms);
    entry.totalMs += ms;
    if (result.ok) entry.ok++;
    else {
      const code = result.errorCode ?? 'UNKNOWN';
      entry.failed[code] = (entry.failed[code] ?? 0) + 1;
      if (code === 'RUNTIME_BUSY') busy++;
    }
  };
  /** Times one read; `into` collects a baseline round instead of the during-run statistics. */
  const timed = async <T extends Outcome>(
    name: string,
    call: () => Promise<T>,
    into?: Record<string, number | string>,
  ): Promise<T> => {
    const begun = performance.now();
    const result = await call();
    const ms = Math.round(performance.now() - begun);
    if (into) into[name] = result.ok ? ms : (result.errorCode ?? 'UNKNOWN');
    else record(name, result, ms);
    return result;
  };
  /** Fast reads: files, Diff, overview, Runs and the connection check. */
  const readRound = async (into?: Record<string, number | string>) => {
    await timed(
      'directory',
      () => api.listWorkspaceDirectory({ projectId: alpha, entryId: rootId }),
      into,
    );
    await timed('file', () => api.readWorkspaceFile({ projectId: alpha, entryId: readmeId }), into);
    await timed(
      'diff',
      () => api.getWorkspaceDiff({ projectId: beta, changeId, part: 'unstaged' }),
      into,
    );
    const overview = await timed('overview', () => api.getWorkspace({ projectId: beta }), into);
    // Each overview replaces the project's entry ids; the window also uses the latest ones.
    if (overview.ok) changeId = noteChange(overview.value) ?? changeId;
    await timed('runs', () => api.listRuns({ projectId: beta }), into);
    await timed(
      'inspect',
      async () => {
        const inspected = await api.inspect();
        return {
          ok: inspected.status === 'connected',
          ...(inspected.errorCode ? { errorCode: inspected.errorCode } : {}),
        };
      },
      into,
    );
  };
  // Two rounds before any run: the first includes cold starts, the second is the idle baseline.
  const coldReads: Record<string, number | string> = {},
    idleReads: Record<string, number | string> = {};
  /** Codex history listing (metadata connection); slow on Codex's side when filtered by folder. */
  const listHistory = (into?: Record<string, number | string>) =>
    timed('threads', () => api.listThreads({ projectId: alpha }), into);
  await readRound(coldReads);
  await listHistory(coldReads);
  await readRound(idleReads);
  await listHistory(idleReads);

  // Codex history is listed in its own loop, already in flight when the messages are sent: a Run
  // must not wait behind it, and its latency must not hide how often the fast reads ran.
  let listing = true;
  const history = (async () => {
    while (listing) await listHistory();
  })();
  await sleep(200);
  const submittedAt = Date.now();
  const submitted = await Promise.all(
    projects.map((projectId, n) =>
      api.submitMessage({
        projectId,
        text: input.prompts[n]!,
        submissionKey: `core1-concurrency-${n}-${submittedAt}`,
      }),
    ),
  );
  const runs: string[] = [];
  for (const result of submitted) {
    if (!result.ok) {
      listing = false;
      return { stage: 'submit', errorCode: result.errorCode };
    }
    runs.push(result.value.runId);
  }

  const terminal = ['completed', 'failed', 'cancelled', 'outcome_unknown'];
  let statuses: string[] = [];
  while (Date.now() - submittedAt < input.runMs) {
    rounds++;
    const views = await Promise.all(
      runs.map((runId, n) => timed('run', () => api.getRun({ projectId: projects[n]!, runId }))),
    );
    statuses = views.map((view) => (view.ok ? view.value.status : 'error'));
    if (statuses.every((status) => terminal.includes(status))) break;
    if (statuses.every((status) => !terminal.includes(status))) bothRunningRounds++;
    // A read-only turn should not ask; anything that does is declined so the turn can finish.
    for (let n = 0; n < 2; n++) {
      const pending = await timed('interactions', () =>
        api.listInteractions({ projectId: projects[n]!, runId: runs[n]! }),
      );
      if (pending.ok)
        for (const request of pending.value.filter((item) => item.state === 'pending')) {
          await api.replyInteraction({
            projectId: projects[n]!,
            runId: runs[n]!,
            requestId: request.requestId,
            decision: 'decline',
          });
          declined++;
        }
    }
    await readRound();
    await sleep(250);
  }
  listing = false;
  await history;
  const finals = await Promise.all(
    runs.map((runId, n) => api.getRun({ projectId: projects[n]!, runId })),
  );
  return {
    stage: 'done' as const,
    connectMs,
    indexObserved,
    runs,
    rounds,
    bothRunningRounds,
    busy,
    declined,
    coldReads,
    idleReads,
    reads: Object.fromEntries(
      Object.entries(reads).map(([name, { totalMs, ...entry }]) => [
        name,
        {
          ...entry,
          avgMs: Math.round(
            totalMs / (entry.ok + Object.values(entry.failed).reduce((a, b) => a + b, 0)),
          ),
        },
      ]),
    ),
    finals: finals.map((view) =>
      view.ok
        ? {
            status: view.value.status,
            taskStatus: view.value.taskStatus,
            thread: Boolean(view.value.threadId),
            turn: Boolean(view.value.turnId),
            // Length only: the answer text itself stays out of the evidence.
            answerChars: (view.value.snapshot?.items ?? [])
              .filter((item) => item.role === 'assistant' && item.kind === 'message')
              .reduce((sum, item) => sum + item.text.length, 0),
          }
        : { status: 'error', errorCode: view.errorCode },
    ),
    sandboxed: api.security.sandboxed,
    isolated: api.security.isolated,
  };
}

type ProbeResult = Awaited<ReturnType<typeof rendererProbe>>;
type ProbeDone = Extract<ProbeResult, { stage: 'done' }>;
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const round = (value: number) => Math.round(value * 100) / 100;

/** Main-process and per-process CPU over an idle window, after the runs are done. */
async function measureIdle(app: App, seconds: number) {
  await sleep(3000);
  app.getAppMetrics(); // starts the percentCPUUsage interval
  const before = process.cpuUsage();
  await sleep(seconds * 1000);
  const used = process.cpuUsage(before);
  const metrics = app.getAppMetrics();
  const byType: Record<string, number> = {};
  for (const metric of metrics)
    byType[metric.type] = round((byType[metric.type] ?? 0) + metric.cpu.percentCPUUsage);
  return {
    seconds,
    mainCpuPercent: round(((used.user + used.system) / 1e6 / seconds) * 100),
    processCpuPercent: byType,
  };
}

export async function runConcurrencyProbe(
  root: string,
  app: App,
  window: BrowserWindow,
  execution: ForegroundExecution,
  projects: string[],
  cliVersion: string,
): Promise<void> {
  const input: ProbeInput = {
    prompts: [
      'Read README.md in the current directory and reply with one short sentence saying what this project is. Do not modify any files.',
      'Read notes.txt in the current directory and reply with one short sentence saying how many lines it has. Do not modify any files.',
    ],
    connectMs: 240_000,
    runMs: 180_000,
  };
  let result: ProbeResult | { stage: string; errorCode: string };
  try {
    result = await window.webContents.executeJavaScript(
      `(${rendererProbe.toString()})(${JSON.stringify(input)})`,
    );
  } catch {
    result = { stage: 'renderer', errorCode: 'PROBE_SCRIPT_FAILED' };
  }
  const done = result.stage === 'done' ? (result as ProbeDone) : null;
  const timings = (done?.runs ?? []).map((runId) => execution.timing(runId));
  const runs = timings.map((timing, n) => ({
    ...(done?.finals?.[n] ?? {}),
    turnAcceptedMs:
      timing?.turnAcceptedAt !== undefined ? timing.turnAcceptedAt - timing.launchedAt : null,
    firstOutputMs:
      timing?.firstOutputAt !== undefined ? timing.firstOutputAt - timing.launchedAt : null,
    totalMs: timing?.finishedAt !== undefined ? timing.finishedAt - timing.launchedAt : null,
  }));
  const [a, b] = timings;
  const overlapMs =
    a?.finishedAt && b?.finishedAt
      ? Math.max(0, Math.min(a.finishedAt, b.finishedAt) - Math.max(a.launchedAt, b.launchedAt))
      : 0;
  if (done)
    await window.webContents.capturePage().then(
      (image) =>
        writeFileSync(resolve(root, '.local/CORE.1-concurrency-desktop.png'), image.toPNG()),
      () => undefined,
    );
  const idle = done ? await measureIdle(app, 60) : null;
  const readsOk = done
    ? Object.entries(done.reads).every(
        ([name, entry]) =>
          entry.ok > 0 && (name === 'interactions' || !Object.keys(entry.failed).length),
      ) &&
      ['directory', 'file', 'diff', 'overview', 'threads', 'runs', 'inspect'].every(
        (name) => (done.reads[name]?.ok ?? 0) > 0,
      )
    : false;
  const passed = Boolean(
    done &&
    runs.length === 2 &&
    runs.every(
      (run) =>
        'status' in run &&
        run.status === 'completed' &&
        typeof run.firstOutputMs === 'number' &&
        'answerChars' in run &&
        Number(run.answerChars) > 0,
    ) &&
    overlapMs > 0 &&
    done.bothRunningRounds > 0 &&
    done.busy === 0 &&
    readsOk &&
    done.sandboxed === true &&
    done.isolated === true &&
    idle &&
    idle.mainCpuPercent < 2,
  );
  writeFileSync(
    resolve(evidenceDir(root), `${CONCURRENCY_EVIDENCE}.json`),
    JSON.stringify(
      {
        status: passed ? 'passed' : 'blocked',
        observedAt: new Date().toISOString(),
        kind: 'real_electron_real_model_two_projects_concurrent',
        backend: 'native_locked_app_server',
        inferenceRequested: true,
        modelTurns: done?.runs.length ?? 0,
        cliVersion,
        platform: `${process.platform}-${process.arch}`,
        stage: result.stage,
        ...('errorCode' in result && result.errorCode ? { code: result.errorCode } : {}),
        ...(done
          ? {
              connectMs: done.connectMs,
              indexObserved: done.indexObserved,
              runs,
              overlapMs,
              rounds: done.rounds,
              bothRunningRounds: done.bothRunningRounds,
              busyRefusals: done.busy,
              interactionsDeclined: done.declined,
              coldReads: done.coldReads,
              idleReads: done.idleReads,
              reads: done.reads,
              idle,
            }
          : {}),
        result: { passed },
      },
      null,
      2,
    ) + '\n',
  );
  for (const directory of projects) rmSync(directory, { recursive: true, force: true });
  app.quit();
}
