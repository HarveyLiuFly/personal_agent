import { createInterface } from 'node:readline';
import { appendFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
const [mode = 'ok', database, receipts] = process.argv.slice(2);
const write = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n');
const notify = (method: string, params: unknown) => write({ method, params });
let cwd = '', threadId = 'fixture-thread';
const requests = new Map<string,(result: Record<string,unknown>)=>void>();
const finish = (text: string, status = 'completed') => {
  notify('item/completed', { threadId, turnId: 'fixture-turn', item: { id: 'fixture-assistant', type: 'agentMessage', text } });
  notify('turn/completed', { threadId, turn: { id: 'fixture-turn', status } });
};
for await (const line of createInterface({ input: process.stdin })) {
  const m = JSON.parse(line);
  if (!m.method && m.id !== undefined) { requests.get(String(m.id))?.(m.result ?? {}); requests.delete(String(m.id)); continue; }
  if (!m.method || m.id === undefined) continue;
  if (m.method === 'initialize') { write({ id: m.id, result: {} }); continue; }
  if (m.method === 'model/list') { write({ id: m.id, result: { data: [{ id: 'synthetic-model', isDefault: true, hidden: false, supportedReasoningEfforts: [{ reasoningEffort: 'low' }], defaultReasoningEffort: 'low' }] } }); continue; }
  if (m.method === 'mcpServerStatus/list') { write({ id: m.id, result: { data: !m.params.threadId || mode === 'external-mcp' ? [{ name: 'fixture-external', pluginId: null }] : mode === 'disabled-list' ? [{ name: 'fixture-external', runtimeStatus: 'disabled', tools: {} }] : [], nextCursor: null } }); continue; }
  if (database && ['thread/start','thread/resume','turn/start'].includes(m.method)) {
    const db = new DatabaseSync(database, { readOnly: true });
    const intent = db.prepare('SELECT state FROM execution_intents WHERE rpc_request_id=?').get(m.id); db.close();
    if (intent?.state !== 'sending') { write({ id: m.id, error: { code: -32600, message: 'fixture intent was not durable before receipt' } }); continue; }
    if (receipts) appendFileSync(receipts, m.method + '\n');
  }
  if (m.method === 'thread/start'||m.method==='thread/resume') {
    if (m.params.config?.['mcp_servers.fixture-external.enabled'] !== false) { write({ id: m.id, error: { code: -32602, message: 'fixture MCP was not disabled' } }); continue; }
    cwd = m.params.cwd; threadId = m.method==='thread/resume'?m.params.threadId:'fixture-thread-' + String(m.id).slice(-12); write({ id: m.id, result: { thread: { id: threadId, cwd,status:{type:'idle'} },approvalPolicy:'on-request',approvalsReviewer:mode==='auto-review'?'auto_review':m.params.approvalsReviewer,
      sandbox:m.params.sandbox==='read-only'?{type:'readOnly',networkAccess:mode==='unsafe-network'}:{type:'workspaceWrite',writableRoots:mode==='unsafe-roots'?['/']:[cwd],networkAccess:mode==='unsafe-network',excludeTmpdirEnvVar:mode!=='unsafe-temp',excludeSlashTmp:true} } }); continue;
  }
  if (m.method === 'turn/start') {
    if (mode === 'reject') { write({ id: m.id, error: { code: -32602, message: 'fixture rejection' } }); continue; }
    if (mode === 'disconnect') process.exit(0);
    if (mode !== 'drop-response') write({ id: m.id, result: { turn: { id: 'fixture-turn' } } });
    const turnId = 'fixture-turn';
    notify('turn/started', { threadId, turn: { id: turnId, status: 'inProgress' } });
    notify('item/completed', { threadId, turnId, item: { id: 'fixture-user', type: 'userMessage', content: m.params.input } });
    notify('item/started', { threadId, turnId, item: { id: 'fixture-assistant', type: 'agentMessage', text: '' } });
    for (const delta of ['a','a','b']) { notify('item/agentMessage/delta', { threadId, turnId, itemId: 'fixture-assistant', delta }); }
    if(mode.startsWith('usage')){
      const db=database?new DatabaseSync(database,{readOnly:true}):undefined,base=Number(db?.prepare('SELECT total_tokens FROM thread_usage WHERE thread_id=?').get(threadId)?.total_tokens??0);db?.close();
      for(const [total,last]of [[base+10,10],[base+10,10],[base+25,15]] as const)notify('thread/tokenUsage/updated',{threadId,turnId,tokenUsage:{total:{totalTokens:total,inputTokens:total-5,cachedInputTokens:0,cacheWriteInputTokens:0,outputTokens:5,reasoningOutputTokens:0},last:{totalTokens:last,inputTokens:last-5,cachedInputTokens:0,cacheWriteInputTokens:0,outputTokens:5,reasoningOutputTokens:0},modelContextWindow:100000}});
    }
    if (mode.startsWith('approval') || mode === 'input') {
      requests.set('server-request', result => {
        if (receipts && result.decision === 'accept') writeFileSync(receipts + '.effect', 'accepted-once');
        finish(mode === 'input' ? JSON.stringify(result) : String(result.decision));
      });
      write({ id: 'server-request', method: mode === 'input' ? 'item/tool/requestUserInput' : 'item/commandExecution/requestApproval', params: {
        threadId, turnId, itemId: 'fixture-command', kind: 'command', command: 'node --test', cwd,
        questions: [{ id: 'scope', header: 'Fixture', question: 'Which scope?', isSecret: false, options: [{label:'continue'}] }] } });
      continue;
    }
    if (mode === 'silent' || mode.startsWith('interrupt')) continue;
    setTimeout(() => {
      notify('item/completed', { threadId, turnId, item: { id: 'fixture-assistant', type: 'agentMessage', text: 'aab' } });
      notify('turn/completed', { threadId, turn: { id: turnId, status: 'completed' } });
    }, mode === 'slow' ? 800 : 25);
    continue;
  }
  if (m.method === 'turn/interrupt' && mode.startsWith('interrupt')) {
    if (receipts) appendFileSync(receipts, 'turn/interrupt\n');
    if (mode !== 'interrupt-timeout') write({ id: m.id, result: {} });
    if (mode === 'interrupt-ok') setTimeout(() => finish('interrupted fixture', 'interrupted'), 15);
    continue;
  }
  write({ id: m.id, error: { code: -32601, message: 'synthetic unsupported method' } });
}
