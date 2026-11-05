// CORE.3a: the pinned Codex accepts each permission mode's thread settings and reports back the
// sandbox and approval policy the executor checks. Ephemeral threads only; no turn, no model.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { StdioRpcClient } from '../packages/codex-adapter/src/rpc.ts';
import { verifiedCodex } from '../packages/codex-adapter/src/binary.ts';
import {
  restrictedAppServerArguments,
  runtimeEnvironment,
} from '../packages/codex-adapter/src/launch.ts';
import { evidenceDir } from './lib/evidence.mjs';

const root = resolve(import.meta.dirname, '..');
const state = resolve(root, '.local/desktop-concurrency-smoke-data/codex-state');
const cwd = mkdtempSync(join(resolve(root, '.local/probe-permission'), 'project-'));
writeFileSync(join(cwd, 'README.md'), '# probe\n');
execFileSync('git', ['init', '-q'], { cwd });
const pin = verifiedCodex(root);
const modes = {
  readOnly: { sandbox: 'read-only', approvalPolicy: 'on-request' },
  auto: { sandbox: 'workspace-write', approvalPolicy: 'on-request' },
  fullAccess: { sandbox: 'danger-full-access', approvalPolicy: 'never' },
} as const;
interface Result {
  approvalPolicy?: unknown;
  approvalsReviewer?: unknown;
  sandboxType?: unknown;
  networkAccess?: unknown;
  writableRootsIsWorkspace?: boolean;
  error?: string;
}
const results: Record<string, Result> = {};
for (const [name, mode] of Object.entries(modes)) {
  const rpc = new StdioRpcClient({
    executable: pin.executable,
    args: restrictedAppServerArguments(state, false),
    env: runtimeEnvironment(),
    requestTimeoutMs: 60_000,
  });
  try {
    await rpc.request('initialize', {
      clientInfo: { name: 'personal_agent_desktop', version: '0.1.0' },
      capabilities: { experimentalApi: false },
    });
    await rpc.notify('initialized');
    const response = await rpc.request<Record<string, unknown>>('thread/start', {
      cwd,
      ephemeral: true,
      sandbox: mode.sandbox,
      approvalPolicy: mode.approvalPolicy,
      approvalsReviewer: 'user',
      config: {
        'sandbox_workspace_write.writable_roots': [cwd],
        'sandbox_workspace_write.network_access': false,
        'sandbox_workspace_write.exclude_tmpdir_env_var': true,
        'sandbox_workspace_write.exclude_slash_tmp': true,
      },
    });
    const sandbox = response.sandbox as Record<string, unknown>;
    results[name] = {
      approvalPolicy: response.approvalPolicy,
      approvalsReviewer: response.approvalsReviewer,
      sandboxType: sandbox?.type,
      networkAccess: sandbox?.networkAccess ?? null,
      writableRootsIsWorkspace:
        Array.isArray(sandbox?.writableRoots) &&
        (sandbox.writableRoots as string[]).every((path) => path === cwd),
    };
  } catch (error) {
    results[name] = { error: error instanceof Error ? error.message : 'FAILED' };
  } finally {
    await rpc.close();
  }
}
const expected = {
  readOnly: (r: Result) =>
    r.approvalPolicy === 'on-request' && r.sandboxType === 'readOnly' && r.networkAccess === false,
  auto: (r: Result) =>
    r.approvalPolicy === 'on-request' &&
    r.sandboxType === 'workspaceWrite' &&
    r.networkAccess === false &&
    r.writableRootsIsWorkspace,
  fullAccess: (r: Result) => r.approvalPolicy === 'never' && r.sandboxType === 'dangerFullAccess',
};
const passed = Object.entries(expected).every(
  ([name, check]) => check(results[name] ?? {}) && results[name]!.approvalsReviewer === 'user',
);
const evidence = {
  status: passed ? 'passed' : 'failed',
  checkpoint: 'CORE.3a',
  kind: 'real pinned CLI, ephemeral threads, no turn and no model request',
  cliVersion: pin.lock.cliVersion,
  results,
  modelRequests: 0,
};
writeFileSync(
  resolve(evidenceDir(root), 'CORE.3a-permission-modes.json'),
  JSON.stringify(evidence, null, 2) + '\n',
);
console.log(JSON.stringify(evidence, null, 2));
if (!passed) process.exitCode = 1;
