import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
const [mode = 'ok', database, receipts] = process.argv.slice(2);
const write = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n');
const notify = (method: string, params: unknown) => write({ method, params });
let cwd = '';
for await (const line of createInterface({ input: process.stdin })) {
  const m = JSON.parse(line);
  if (!m.method || m.id === undefined) continue;
  if (m.method === 'initialize') { write({ id: m.id, result: {} }); continue; }
  if (m.method === 'model/list') { write({ id: m.id, result: { data: [{ id: 'synthetic-model', isDefault: true, hidden: false, supportedReasoningEfforts: [{ reasoningEffort: 'low' }], defaultReasoningEffort: 'low' }] } }); continue; }
  if (m.method === 'mcpServerStatus/list') { write({ id: m.id, result: { data: !m.params.threadId || mode === 'external-mcp' ? [{ name: 'fixture-external', pluginId: null }] : mode === 'disabled-list' ? [{ name: 'fixture-external', runtimeStatus: 'disabled', tools: {} }] : [], nextCursor: null } }); continue; }
  if (database && ['thread/start','turn/start'].includes(m.method)) {
    const db = new DatabaseSync(database, { readOnly: true });
    const intent = db.prepare('SELECT state FROM execution_intents WHERE rpc_request_id=?').get(m.id); db.close();
    if (intent?.state !== 'sending') { write({ id: m.id, error: { code: -32600, message: 'fixture intent was not durable before receipt' } }); continue; }
    if (receipts) appendFileSync(receipts, m.method + '\n');
  }
  if (m.method === 'thread/start') {
    if (m.params.config?.['mcp_servers.fixture-external.enabled'] !== false) { write({ id: m.id, error: { code: -32602, message: 'fixture MCP was not disabled' } }); continue; }
    cwd = m.params.cwd; write({ id: m.id, result: { thread: { id: 'fixture-thread', cwd } } }); continue;
  }
  if (m.method === 'turn/start') {
    if (mode === 'reject') { write({ id: m.id, error: { code: -32602, message: 'fixture rejection' } }); continue; }
    if (mode === 'disconnect') process.exit(0);
    if (mode !== 'drop-response') write({ id: m.id, result: { turn: { id: 'fixture-turn' } } });
    const threadId = 'fixture-thread', turnId = 'fixture-turn';
    notify('turn/started', { threadId, turn: { id: turnId, status: 'inProgress' } });
    notify('item/completed', { threadId, turnId, item: { id: 'fixture-user', type: 'userMessage', content: m.params.input } });
    notify('item/started', { threadId, turnId, item: { id: 'fixture-assistant', type: 'agentMessage', text: '' } });
    for (const delta of ['a','a','b']) { notify('item/agentMessage/delta', { threadId, turnId, itemId: 'fixture-assistant', delta }); }
    if (mode === 'silent') continue;
    setTimeout(() => {
      notify('item/completed', { threadId, turnId, item: { id: 'fixture-assistant', type: 'agentMessage', text: 'aab' } });
      notify('turn/completed', { threadId, turn: { id: turnId, status: 'completed' } });
    }, mode === 'slow' ? 800 : 25);
    continue;
  }
  write({ id: m.id, error: { code: -32601, message: 'synthetic unsupported method' } });
}
