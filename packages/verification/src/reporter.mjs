import {resolve} from 'node:path';
// Trusted reporter: never forward arbitrary test stdout, stderr, stacks or diagnostic text.
export default async function* report(events) {
  for await (const event of events) {
    if (event.type !== 'test:pass' && event.type !== 'test:fail') continue;
    const d = event.data;
    // Node 24 emits a passing file-wrapper at line 1 even when no test() ran.
    if (d.details?.type === 'suite' || !Number.isSafeInteger(d.line) || (typeof d.name === 'string' && typeof d.file === 'string' && resolve(d.name) === resolve(d.file))) continue;
    yield JSON.stringify({ type: event.type, name: String(d.name), file: d.file, line: d.line,
      column: d.column ?? 0, skipped: Boolean(d.skip || d.todo) }) + '\n';
  }
}
