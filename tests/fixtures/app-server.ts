import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const [file, mode] = process.argv.slice(2);
let initialized = false;
const event = (data: object) =>
  appendFileSync(file!, JSON.stringify({ pid: process.pid, ...data }) + '\n');
event({ event: 'spawn' });
const send = (id: unknown, result: unknown) =>
  process.stdout.write(JSON.stringify({ id, result }) + '\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  const q = JSON.parse(line);
  event({ event: 'request', method: q.method });
  if (q.method === 'initialize') {
    if (mode === 'backfill') {
      process.stderr.write('state db backfill is running at /fixture/private-home\n');
      process.exit(7);
    }
    if (initialized) {
      process.stdout.write(
        JSON.stringify({ id: q.id, error: { code: -32600, message: 'Already initialized' } }) +
          '\n',
      );
      return;
    }
    initialized = true;
    setTimeout(() => send(q.id, { ready: true }), mode === 'slow' ? 100 : 0);
    return;
  }
  if (q.method === 'initialized') return;
  if (!initialized) {
    process.stdout.write(
      JSON.stringify({ id: q.id, error: { code: -32600, message: 'Not initialized' } }) + '\n',
    );
    return;
  }
  if (q.method === 'thread/turns/list') {
    process.exit(7);
  }
  if (q.method === 'thread/items/list') return;
  if (q.method === 'model/list')
    send(q.id, { data: [{ id: 'fixture', isDefault: true, hidden: false }] });
  else send(q.id, { pid: process.pid, params: q.params });
});
