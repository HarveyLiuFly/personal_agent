import assert from 'node:assert/strict';
import { test } from 'node:test';
import { script } from '../apps/desktop/src/core2-acceptance-probe.ts';

test('every acceptance phase injects a script that parses', () => {
  for (const phase of ['first', 'restart', 'recover']) {
    const source = script(phase, { conversationId: 'c', killRunId: 'r' });
    assert.doesNotThrow(() => new Function('return ' + source), phase);
  }
});
