import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { verifiedCodex } from '../packages/codex-adapter/src/binary.ts';
import { StdioRpcClient } from '../packages/codex-adapter/src/rpc.ts';
import { executionArguments } from '../packages/runtime/src/execution.ts';
import { runtimeEnvironment } from '../packages/codex-adapter/src/launch.ts';
const root = resolve('.');
mkdirSync(join(root, '.local'), { recursive: true });
const state = mkdtempSync(join(root, '.local/dot-role-probe-'));
let rpc: StdioRpcClient | undefined,
  phase = 'initialize',
  evidence: Record<string, unknown>;
try {
  rpc = new StdioRpcClient({
    executable: verifiedCodex(root).executable,
    args: executionArguments(state, true),
    env: runtimeEnvironment(),
    requestTimeoutMs: 30000,
  });
  await rpc.request('initialize', {
    clientInfo: { name: 'm3_metadata_probe', version: '1' },
    capabilities: { experimentalApi: false },
  });
  await rpc.notify('initialized');
  phase = 'config/read';
  const c = (await rpc.request<any>('config/read', { cwd: root, includeLayers: false })).config,
    features = c.features ?? {},
    flags = [
      'shell_tool',
      'unified_exec',
      'view_image',
      'image_generation',
      'sleep_tool',
      'skill_search',
      'tool_suggest',
      'memories',
    ];
  const result = {
    ...Object.fromEntries(flags.map((f) => [f, features[f] === false])),
    webDisabled: c.web_search === 'disabled',
  };
  evidence = {
    status: Object.values(result).every(Boolean) ? 'passed' : 'blocked',
    phase,
    kind: 'locked_cli_effective_disabled_dot_role_configuration',
    result,
    inferenceRequested: false,
  };
} catch (error) {
  evidence = {
    status: 'blocked',
    phase,
    code: error instanceof Error ? error.message : 'HOST_ERROR',
    inferenceRequested: false,
  };
} finally {
  await rpc?.close();
  rmSync(state, { recursive: true, force: true });
}
evidence.observedAt = new Date().toISOString();
writeFileSync(
  join(root, 'docs/progress/evidence/M3.1b-native-role-config.json'),
  JSON.stringify(evidence, null, 2) + '\n',
);
console.log(JSON.stringify(evidence, null, 2));
if (evidence.status !== 'passed') process.exitCode = 1;
