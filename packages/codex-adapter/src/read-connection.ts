import { StdioRpcClient } from './rpc.ts';
import { launchArguments, runtimeEnvironment } from './launch.ts';
import type { WithReadPort } from './history.ts';

/** The optional isolated home is used only by local fixture tooling, never selected over Renderer IPC. */
export function readConnection(executable: string, stateDirectory: string, signal?: AbortSignal, isolatedHome?: string): WithReadPort {
  return async read => {
    const env = runtimeEnvironment(); if (isolatedHome) env.CODEX_HOME = isolatedHome;
    const rpc = new StdioRpcClient({ executable, args: launchArguments(stateDirectory), env, signal });
    try {
      await rpc.request('initialize', { clientInfo: { name: 'personal_agent_history', version: '0.1.0' }, capabilities: { experimentalApi: false } });
      await rpc.notify('initialized');
      return await read(rpc);
    } finally { await rpc.close(); }
  };
}
