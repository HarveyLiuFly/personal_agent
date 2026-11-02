import { createInterface } from 'node:readline';
const mode = process.argv[2];
const lines = createInterface({ input: process.stdin });
const counts: Record<string, number> = {};
const queued: Array<Record<string, unknown>> = [];
let originalId: unknown;
const send = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n');
lines.on('line', line => {
  const message = JSON.parse(line) as Record<string, unknown>;
  if (!message.method) {
    if (mode === 'approval') send({ id: originalId, result: { declined: (message.result as { decision?: string })?.decision === 'decline' } });
    if (mode === 'unsupported') send({ id: originalId, result: { denied: (message.error as { code?: number })?.code === -32601 } });
    return;
  }
  const method = String(message.method);
  counts[method] = (counts[method] ?? 0) + 1;
  if (mode === 'reverse') {
    queued.push(message);
    if (queued.length === 2) for (const item of queued.reverse()) send({ id: item.id, result: item.params });
  } else if (mode === 'approval' || mode === 'unsupported') {
    originalId = message.id;
    send({ id: mode === 'approval' ? 1 : 'unknown-request',
      method: mode === 'approval' ? 'item/commandExecution/requestApproval' : 'unsupported/tool', params: {} });
  } else if (mode === 'unicode') {
    const bytes = Buffer.from(JSON.stringify({ method: 'test/delta', params: { text: '你你好' } }) + '\n');
    const split = bytes.indexOf(Buffer.from('你')) + 1;
    process.stdout.write(bytes.subarray(0, split));
    setTimeout(() => { process.stdout.write(bytes.subarray(split)); send({ id: message.id, result: true }); }, 10);
  } else if (mode === 'malformed') process.stdout.write('not-json\n');
  else if (mode === 'remote-error' && method === 'test/fail') send({ id: message.id, error: { code: -32600, message: 'fixture-private-diagnostic' } });
  else if (mode === 'oversize') process.stdout.write('x'.repeat(2048));
  else if (mode === 'utf8') process.stdout.write(Buffer.from([123, 34, 120, 34, 58, 34, 255, 34, 125, 10]));
  else if (mode === 'crash') process.exit(7);
  else if (mode === 'timeout' && method === 'test/timeout') return;
  else if (method === 'test/count') send({ id: message.id, result: counts });
  else send({ id: message.id, result: message.params });
});
