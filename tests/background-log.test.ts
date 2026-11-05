import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { BackgroundLog, errorCode } from '../apps/desktop/src/background-log.ts';

test('background failures are recorded by source and code, at most once a minute', () => {
  const directory = mkdtempSync(join(tmpdir(), 'personal-agent-background-log-'));
  const warn = console.warn;
  console.warn = () => {};
  try {
    const log = new BackgroundLog(directory),
      failure = Object.assign(new Error('private /home/path detail'), { code: 'OWNER_FENCED' });
    log.record('outbox', failure, 1_000);
    log.record('outbox', failure, 30_000);
    log.record('schedules', failure, 30_000);
    log.record('outbox', failure, 61_001);
    const lines = readFileSync(join(directory, 'background.log'), 'utf8').trim().split('\n');
    assert.deepEqual(
      lines.map((line) => line.split(' ').slice(1).join(' ')),
      ['outbox OWNER_FENCED', 'schedules OWNER_FENCED', 'outbox OWNER_FENCED'],
    );
    assert.equal(readFileSync(join(directory, 'background.log'), 'utf8').includes('/home'), false);
    assert.equal(errorCode(new TypeError('x')), 'TypeError');
    assert.equal(errorCode('text'), 'UNKNOWN_ERROR');
  } finally {
    console.warn = warn;
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the background log rotates once it passes 1 MB', () => {
  const directory = mkdtempSync(join(tmpdir(), 'personal-agent-background-log-'));
  const warn = console.warn;
  console.warn = () => {};
  try {
    writeFileSync(join(directory, 'background.log'), 'x'.repeat(1_048_577));
    new BackgroundLog(directory).record('goals', new Error('boom'), 0);
    assert.equal(existsSync(join(directory, 'background.log.1')), true);
    assert.match(readFileSync(join(directory, 'background.log'), 'utf8'), /goals Error\n$/);
  } finally {
    console.warn = warn;
    rmSync(directory, { recursive: true, force: true });
  }
});
