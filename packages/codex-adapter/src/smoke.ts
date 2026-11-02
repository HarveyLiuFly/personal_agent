import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StdioRpcClient, RpcFailure, isObject } from './rpc.ts';
import { launchArguments, runtimeEnvironment } from './launch.ts';
import type { InitializeResponse } from './generated/InitializeResponse.ts';
import type { ModelListResponse } from './generated/v2/ModelListResponse.ts';
import type { ThreadStartParams } from './generated/v2/ThreadStartParams.ts';
import type { ThreadStartResponse } from './generated/v2/ThreadStartResponse.ts';
import type { TurnStartParams } from './generated/v2/TurnStartParams.ts';
import type { TurnStartResponse } from './generated/v2/TurnStartResponse.ts';
import type { ThreadReadResponse } from './generated/v2/ThreadReadResponse.ts';

export interface SmokeResult {
  status: 'passed';
  model: string;
  threadId: string;
  turnId: string;
  finalText: string;
  expectedText: string;
  serverRequestsDenied: number;
  toolItems: number;
  notificationCounts: Record<string, number>;
  completionSource: 'notification' | 'snapshot';
}

const initialization = {
  clientInfo: { name: 'personal_agent_desktop', title: 'Personal Agent', version: '0.1.0' },
  capabilities: { experimentalApi: false, requestAttestation: false },
};

export async function inspectConnection(executable: string, stateDirectory: string, signal?: AbortSignal): Promise<{ models: number; defaultModel: string }> {
  const rpc = new StdioRpcClient({ executable, args: launchArguments(stateDirectory), env: runtimeEnvironment(), signal });
  try {
    await rpc.request<InitializeResponse>('initialize', initialization);
    await rpc.notify('initialized');
    const response = await rpc.request<ModelListResponse>('model/list', {});
    if (!Array.isArray(response.data)) throw new RpcFailure('INVALID_MODEL_CATALOG');
    const model = response.data.find(item => item.isDefault && !item.hidden);
    if (!model) throw new RpcFailure('NO_DEFAULT_MODEL');
    return { models: response.data.length, defaultModel: model.id };
  } finally { await rpc.close(); }
}

/** One bounded, read-only, no-tools model request. Does not reuse task history or create user files. */
export async function runRealSmoke(executable: string, stateDirectory: string, signal?: AbortSignal): Promise<SmokeResult> {
  const workspace = await mkdtemp(join(tmpdir(), 'personal-agent-m0-'));
  const expectedText = `M0_READY_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const notificationCounts: Record<string, number> = {};
  const notificationShapes: Record<string, string[]> = {};
  const upstreamErrors: unknown[] = [];
  const textByItem = new Map<string, string>();
  let serverRequestsDenied = 0;
  let toolItems = 0;
  let activeThreadId: string | undefined;
  let activeTurnId: string | undefined;
  let phase = 'initialize';
  let lastKnownStatus: string | undefined;
  let resolveCompletion!: (value: Record<string, unknown>) => void;
  const completed = new Promise<Record<string, unknown>>(resolve => { resolveCompletion = resolve; });
  const rpc = new StdioRpcClient({
    executable, args: launchArguments(stateDirectory), env: runtimeEnvironment(),
    requestTimeoutMs: 25_000, signal,
    onServerRequest: async request => {
      serverRequestsDenied++;
      if (request.method === 'item/commandExecution/requestApproval' || request.method === 'item/fileChange/requestApproval') {
        return { decision: 'decline' };
      }
      throw new RpcFailure('UNSUPPORTED_SERVER_REQUEST');
    },
    onNotification: message => {
      const method = String(message.method);
      notificationCounts[method] = (notificationCounts[method] ?? 0) + 1;
      if (isObject(message.params)) notificationShapes[method] = Object.keys(message.params).sort();
      if (!isObject(message.params) || message.params.threadId !== activeThreadId) return;
      const params = message.params;
      if (method === 'error' && isObject(params.error)) {
        const message = typeof params.error.message === 'string' ? params.error.message : '';
        const transport = /websocket/i.test(message) ? 'websocket' : /\bSSE\b|event.?stream/i.test(message) ? 'sse' : undefined;
        const httpStatus = message.match(/\b(?:status(?: code)?[: ]+|HTTP[\/\d. ]*)([45]\d{2})\b/i)?.[1];
        // Record only fixed classifications, never arbitrary error text, URLs, headers or credentials.
        const classification = /certificate|\bTLS\b/i.test(message) ? 'tls' : /unauthorized|authentication|\b401\b|\b403\b/i.test(message) ? 'authorization'
          : /timed? out|timeout/i.test(message) ? 'timeout' : /connection (?:refused|reset)|error sending request/i.test(message) ? 'connection' : undefined;
        const safeDiagnostic = { transport, classification, statusFromMessage: httpStatus ? Number(httpStatus) : undefined,
          willRetry: params.willRetry === true };
        const info = params.error.codexErrorInfo;
        if (typeof info === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(info)) upstreamErrors.push({ kind: info, ...safeDiagnostic });
        else if (isObject(info)) {
          const kind = Object.keys(info)[0];
          const value = kind ? info[kind] : undefined;
          if (kind && /^[a-zA-Z0-9_-]{1,80}$/.test(kind)) upstreamErrors.push({ kind, ...safeDiagnostic,
            httpStatusCode: isObject(value) && typeof value.httpStatusCode === 'number' ? value.httpStatusCode : null });
        }
      }
      if (method === 'item/agentMessage/delta' && typeof params.itemId === 'string' && typeof params.delta === 'string') {
        textByItem.set(params.itemId, (textByItem.get(params.itemId) ?? '') + params.delta);
      }
      if ((method === 'item/started' || method === 'item/completed') && isObject(params.item)) {
        const item = params.item;
        if (method === 'item/started' && !['userMessage', 'agentMessage', 'reasoning', 'plan', 'contextCompaction'].includes(String(item.type))) toolItems++;
        if (method === 'item/completed' && item.type === 'agentMessage' && typeof item.id === 'string' && typeof item.text === 'string') {
          textByItem.set(item.id, item.text);
        }
      }
      if (method === 'turn/completed' && isObject(params.turn)) resolveCompletion(params.turn);
    },
  });
  let timer: NodeJS.Timeout | undefined;
  try {
    await rpc.request<InitializeResponse>('initialize', initialization);
    await rpc.notify('initialized');
    phase = 'model/list';
    const catalog = await rpc.request<ModelListResponse>('model/list', {});
    if (!Array.isArray(catalog.data)) throw new RpcFailure('INVALID_MODEL_CATALOG');
    const model = catalog.data.find(item => item.isDefault && !item.hidden);
    if (!model) throw new RpcFailure('NO_DEFAULT_MODEL');
    const params: ThreadStartParams = { cwd: workspace, model: model.id, sandbox: 'read-only', approvalPolicy: 'on-request',
      ephemeral: true, developerInstructions: 'Protocol smoke verification only. Do not call tools, read files, or access any website. Reply with the exact requested marker and nothing else.' };
    phase = 'thread/start';
    const thread = await rpc.request<ThreadStartResponse>('thread/start', params);
    if (!thread.thread || typeof thread.thread.id !== 'string') throw new RpcFailure('INVALID_THREAD_RESPONSE');
    activeThreadId = thread.thread.id;
    const turnParams: TurnStartParams = { threadId: activeThreadId,
      input: [{ type: 'text', text: `Return exactly ${expectedText}`, text_elements: [] }],
      sandboxPolicy: { type: 'readOnly', networkAccess: false }, approvalPolicy: 'on-request',
      effort: model.supportedReasoningEfforts.some(option => option.reasoningEffort === 'low') ? 'low' : model.defaultReasoningEffort };
    phase = 'turn/start';
    const accepted = await rpc.request<TurnStartResponse>('turn/start', turnParams);
    activeTurnId = accepted.turn.id;
    phase = 'turn/completed';
    let completionSource: 'notification' | 'snapshot' = 'notification';
    let final = await Promise.race([completed, rpc.waitClosed().then(() => {
      throw new RpcFailure('PROCESS_EXITED', true);
    }), new Promise<null>(resolve => {
      timer = setTimeout(() => resolve(null), 90_000);
    })]);
    if (final === null) {
      phase = 'thread/read';
      let snapshot: ThreadReadResponse;
      try { snapshot = await rpc.request<ThreadReadResponse>('thread/read', { threadId: activeThreadId, includeTurns: true }); }
      catch { throw new RpcFailure('TURN_TIMEOUT', true); } // A failed reconciliation cannot make an accepted Turn known-safe to repeat.
      const turn = snapshot.thread.turns.find(item => item.id === activeTurnId);
      lastKnownStatus = turn?.status;
      if (!turn || turn.status !== 'completed') throw new RpcFailure('TURN_TIMEOUT', true);
      for (const item of turn.items) if (item.type === 'agentMessage') textByItem.set(item.id, item.text);
      final = { id: turn.id, status: turn.status };
      completionSource = 'snapshot';
    }
    lastKnownStatus = typeof final.status === 'string' ? final.status : undefined;
    if (final.id !== accepted.turn.id) throw new RpcFailure('TURN_ID_MISMATCH', true);
    if (final.status !== 'completed') throw new RpcFailure(final.status === 'failed' ? 'TURN_FAILED' : 'TURN_NOT_COMPLETED', final.status !== 'failed' && final.status !== 'interrupted');
    const finalText = [...textByItem.values()].join('').trim();
    if (finalText !== expectedText) throw new RpcFailure('SMOKE_CONTENT_MISMATCH');
    if (toolItems !== 0 || serverRequestsDenied !== 0) throw new RpcFailure('UNEXPECTED_TOOL_ACTIVITY');
    return { status: 'passed', model: model.id, threadId: activeThreadId, turnId: accepted.turn.id,
      finalText, expectedText, serverRequestsDenied, toolItems, notificationCounts, completionSource };
  } catch (error) {
    const failure = error instanceof RpcFailure ? error : new RpcFailure('HOST_ERROR', true);
    throw new RpcFailure(failure.code, failure.outcomeUnknown, { phase, threadId: activeThreadId,
      turnId: activeTurnId, lastKnownStatus, notificationCounts, notificationShapes,
      upstreamErrors, serverRequestsDenied, toolItems });
  } finally {
    if (timer) clearTimeout(timer);
    await rpc.close();
    await rm(workspace, { recursive: true, force: true });
  }
}
