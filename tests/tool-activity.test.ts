import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ThreadProjection, itemView } from '../packages/codex-adapter/src/projection.ts';
import { toolActivities } from '../apps/desktop/renderer/tool-activity.ts';
import type { ItemView, RunView } from '../packages/contracts/src/views.ts';

function run(items: ItemView[], status = 'running', needsSnapshot = false): RunView {
  return {
    runId: 'r',
    taskId: 't',
    title: 'public',
    status,
    taskStatus: 'running',
    threadId: 'thread',
    turnId: 'turn',
    blocked: false,
    mode: 'readOnly',
    snapshot: {
      threadId: 'thread',
      epoch: 1,
      sequence: 1,
      needsSnapshot,
      truncated: false,
      unsupportedItems: false,
      turns: [{ id: 'turn', status: 'inProgress' }],
      items,
    },
  };
}
test('tool status is explicit and independent of final record receipt; invalid metadata is dropped', () => {
  for (const status of ['inProgress', 'completed', 'failed', 'declined'] as const) {
    const view = itemView(
      'turn',
      {
        id: 'c',
        type: 'commandExecution',
        status,
        exitCode: 1,
        durationMs: 25,
        command: 'public command',
        arguments: { secret: 'DO_NOT_COPY' },
        cwd: '/private/path',
        processId: 'private',
      },
      true,
    )!;
    assert.equal(view.status, 'complete');
    assert.equal(view.toolStatus, status);
    assert.equal(view.exitCode, 1);
    assert.equal(view.durationMs, 25);
    assert.equal(JSON.stringify(view).includes('DO_NOT_COPY'), false);
    assert.equal(JSON.stringify(view).includes('/private/path'), false);
    assert.equal('processId' in view, false);
  }
  const invalid = itemView(
    'turn',
    { id: 'c', type: 'commandExecution', status: 'future', exitCode: NaN, durationMs: -1 },
    true,
  )!;
  assert.equal(invalid.toolStatus, 'unknown');
  assert.equal('exitCode' in invalid, false);
  assert.equal('durationMs' in invalid, false);
});
test('completed Turn and snapshot do not fabricate success for failed, declined or unfinished tools', () => {
  const projection = new ThreadProjection('thread');
  projection.replaceSnapshot(1, 0, [
    {
      id: 'turn',
      status: 'completed',
      items: [
        { id: 'failed', type: 'commandExecution', status: 'failed', exitCode: 1 },
        { id: 'declined', type: 'fileChange', status: 'declined', changes: [] },
        { id: 'pending', type: 'commandExecution', status: 'inProgress' },
        { id: 'old', type: 'commandExecution' },
      ],
    },
  ]);
  const view = run(projection.view().items, 'completed');
  view.snapshot = projection.view();
  assert.deepEqual(
    toolActivities(view).map((a) => a.state),
    ['failed', 'declined', 'unknown', 'unknown'],
  );
});
test('late tool starts and output cannot erase a failed final result; reconnect requires fresh snapshot', () => {
  const projection = new ThreadProjection('thread');
  let sequence = 0;
  const send = (method: string, params: Record<string, unknown>) =>
    projection.receive(1, ++sequence, {
      method,
      params: { threadId: 'thread', turnId: 'turn', ...params },
    });
  send('turn/started', { turn: { id: 'turn', status: 'inProgress' } });
  send('item/started', {
    item: { id: 'c', type: 'commandExecution', status: 'inProgress', command: 'public' },
  });
  send('item/commandExecution/outputDelta', { itemId: 'c', delta: 'output' });
  send('item/completed', {
    item: {
      id: 'c',
      type: 'commandExecution',
      status: 'failed',
      command: 'public',
      aggregatedOutput: 'failed output',
      exitCode: 3,
    },
  });
  send('item/started', { item: { id: 'c', type: 'commandExecution', status: 'inProgress' } });
  send('item/commandExecution/outputDelta', { itemId: 'c', delta: 'late' });
  assert.equal(projection.view().items[0]?.toolStatus, 'failed');
  assert.equal(projection.view().items[0]?.text, 'public\nfailed output');
  projection.reconnect(2);
  assert.equal(projection.view().needsSnapshot, true);
  assert.equal(projection.view().items[0]?.exitCode, 3);
});
test('nonzero exit, interrupted tool and old metadata cannot appear as successful executions', () => {
  const items = [
    itemView(
      'turn',
      { id: 'nonzero', type: 'commandExecution', status: 'completed', exitCode: 7 },
      true,
    )!,
    itemView(
      'turn',
      {
        id: 'interrupted',
        type: 'collabAgentToolCall',
        status: 'interrupted',
        prompt: 'DO_NOT_COPY',
      },
      true,
    )!,
    itemView(
      'turn',
      {
        id: 'mcp',
        type: 'mcpToolCall',
        status: 'failed',
        arguments: { token: 'DO_NOT_COPY' },
        result: { secret: 'DO_NOT_COPY' },
        error: { message: 'DO_NOT_COPY' },
      },
      true,
    )!,
    itemView('turn', { id: 'message', type: 'agentMessage', text: 'success' }, true)!,
  ];
  assert.deepEqual(
    toolActivities(run(items)).map((a) => a.state),
    ['failed', 'interrupted', 'failed'],
  );
  assert.equal(JSON.stringify(items).includes('DO_NOT_COPY'), false);
});
test('live tool requires fresh snapshot, active Run and matching active Turn; older snapshot is unknown', () => {
  const item = itemView(
    'turn',
    { id: 'c', type: 'commandExecution', status: 'inProgress' },
    false,
  )!;
  assert.equal(toolActivities(run([item]))[0]?.state, 'inProgress');
  for (const status of [
    'preparing',
    'submitting',
    'completed',
    'failed',
    'cancelled',
    'outcome_unknown',
  ])
    assert.equal(toolActivities(run([item], status))[0]?.state, 'unknown');
  assert.equal(toolActivities(run([item], 'running', true))[0]?.state, 'unknown');
  const missing = run([item]);
  missing.snapshot!.turns = [];
  assert.equal(toolActivities(missing)[0]?.state, 'unknown');
  const old = { ...item };
  delete old.toolStatus;
  assert.equal(toolActivities(run([old]))[0]?.state, 'unknown');
});
test('tool projection obeys existing per-item and aggregate display budgets', () => {
  const projection = new ThreadProjection('thread', 1, { itemText: 4, totalText: 5, items: 2 });
  projection.replaceSnapshot(1, 0, [
    {
      id: 'turn',
      status: 'completed',
      items: [
        {
          id: 'a',
          type: 'commandExecution',
          status: 'failed',
          command: '🙂🙂🙂',
          aggregatedOutput: 'large',
          exitCode: 2,
          durationMs: 5,
        },
        { id: 'b', type: 'mcpToolCall', status: 'failed', server: 'longserver', tool: 'longtool' },
        { id: 'c', type: 'fileChange', status: 'completed', changes: [] },
      ],
    },
  ]);
  const view = projection.view();
  assert.equal(view.items.length, 2);
  assert.equal(view.truncated, true);
  assert.ok(view.items.reduce((n, i) => n + i.text.length, 0) <= 5);
  assert.equal(view.items[0]?.toolStatus, 'failed');
  assert.equal(view.items[0]?.exitCode, 2);
  assert.equal(toolActivities(run([])).length, 0);
});
