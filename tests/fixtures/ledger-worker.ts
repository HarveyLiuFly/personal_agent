import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ExecutionLedger } from '../../packages/store/src/ledger.ts';
import { SINGLE_RUN_POLICY } from './policies.ts';
const [file, workspace] = process.argv.slice(2);
if (!file || !workspace) throw new Error('FIXTURE_ARGUMENTS_REQUIRED');
const store = new ExecutionLedger(
  file,
  readFileSync(resolve('docs/design/contracts/schema.sql'), 'utf8'),
  { budgetPolicy: SINGLE_RUN_POLICY },
);
store.startOwner('real-child-fixture', true);
const project = store.registerWorkspace(workspace);
const { token } = store.beginRun(project.id, 'crash fixture', 'crash-key', 'readOnly');
const intent = store.prepare(token, 'crash-intent', 'thread_start', {});
store.sending(token, intent.intentId, 1);
process.stdout.write(
  JSON.stringify({ projectId: project.id, runId: token.runId, intentId: intent.intentId }) + '\n',
);
setInterval(() => {}, 1000);
