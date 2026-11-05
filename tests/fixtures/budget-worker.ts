import { readFileSync } from 'node:fs';
import { ExecutionLedger } from '../../packages/store/src/ledger.ts';
const [file, cwd] = process.argv.slice(2);
if (!file || !cwd) throw new Error('ARGUMENTS_REQUIRED');
const store = new ExecutionLedger(file, readFileSync('docs/design/contracts/schema.sql', 'utf8'), {
  budgetPolicy: { dailyTokens: 100, reservationTokens: 60 },
});
store.startOwner('budget-child-fixture', true);
const project = store.registerWorkspace(cwd, cwd),
  { token } = store.beginRun(project.id, 'synthetic budget crash fixture', 'crash', 'readOnly');
const thread = store.prepare(token, 'thread', 'thread_start', {});
store.sending(token, thread.intentId, 1);
store.accepted(token, thread.intentId, { threadId: 'synthetic-budget-thread' });
const turn = store.prepare(token, 'turn', 'turn_start', {}, 'synthetic-budget-thread');
store.sending(token, turn.intentId, 1);
store.accepted(token, turn.intentId, { turnId: 'synthetic-budget-turn' });
store.recordTokenUsage(token, 'synthetic-budget-thread', 'synthetic-budget-turn', 20);
process.stdout.write(JSON.stringify({ projectId: project.id, runId: token.runId }) + '\n');
setInterval(() => {}, 1000);
