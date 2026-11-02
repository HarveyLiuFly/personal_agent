import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ThreadProjection, itemView } from '../packages/codex-adapter/src/projection.ts';

function setup(limits = {}) {
  const projection = new ThreadProjection('thread', 1, limits);
  let sequence = 0;
  const send = (method: string, params: Record<string, unknown>) => projection.receive(1, ++sequence, { method, params: { threadId: 'thread', turnId: 'turn', ...params } });
  const delta = (text: string, params = {}) => send('item/agentMessage/delta', { itemId: 'item', delta: text, ...params });
  const finish = (text: string) => send('item/completed', { item: { type: 'agentMessage', id: 'item', text } });
  return { projection, send, delta, finish };
}
test('repeated deltas are appended and the authoritative final item calibrates them', () => {
  const { projection, delta, finish } = setup();
  for (const text of ['a', 'a', 'b']) delta(text);
  assert.equal(projection.view().items[0]?.text, 'aab');
  finish('校准后的完整结果');
  delta('迟到片段');
  assert.equal(projection.view().items[0]?.text, '校准后的完整结果');
  assert.equal(projection.view().items[0]?.status, 'complete');
});
test('a late item/started does not erase text or reopen a completed item', () => {
  const { projection, send, delta, finish } = setup();
  delta('开头');
  send('item/started', { item: { type: 'agentMessage', id: 'item', text: '' } });
  assert.equal(projection.view().items[0]?.text, '开头');
  finish('最终');
  send('item/started', { item: { type: 'agentMessage', id: 'item', text: '' } });
  assert.equal(projection.view().items[0]?.text, '最终');
});
test('thread, turn and item identity remain separate even with equal IDs and delimiter-like strings', () => {
  const { projection, delta } = setup();
  delta('A'); delta('B', { turnId: 'turn-2' }); delta('private', { threadId: 'foreign' });
  delta('C', { turnId: 'a:b', itemId: 'c' }); delta('D', { turnId: 'a', itemId: 'b:c' });
  assert.deepEqual(projection.view().items.map(item => item.text), ['A', 'B', 'C', 'D']);
});
test('duplicate receive identities do not duplicate text, while a gap requires reconciliation', () => {
  const projection = new ThreadProjection('thread');
  const message = { method: 'item/agentMessage/delta', params: { threadId: 'thread', turnId: 't', itemId: 'i', delta: 'a' } };
  projection.receive(1, 1, message); projection.receive(1, 1, message);
  assert.equal(projection.view().items[0]?.text, 'a');
  projection.receive(1, 3, message);
  assert.equal(projection.view().needsSnapshot, true);
  assert.equal(projection.view().items[0]?.text, 'a');
});
test('reconnection requires a fresh snapshot and replaces old partial text rather than concatenating it', () => {
  const { projection, delta } = setup(); delta('旧片段');
  projection.reconnect(2);
  const event = { method: 'item/agentMessage/delta', params: { threadId: 'thread', turnId: 'turn', itemId: 'item', delta: '不能拼接' } };
  projection.receive(1, 2, event); projection.receive(2, 1, event);
  assert.equal(projection.view().items[0]?.text, '旧片段');
  projection.replaceSnapshot(2, 1, [{ id: 'turn', status: 'completed', items: [{ type: 'agentMessage', id: 'item', text: '权威快照' }] }]);
  assert.equal(projection.view().needsSnapshot, false);
  assert.equal(projection.view().items[0]?.text, '权威快照');
  assert.throws(() => projection.replaceSnapshot(1, 99, []), /STALE_SNAPSHOT/);
});
test('disconnect leaves partial content explicitly stale and blocks additional updates', () => {
  const { projection, delta } = setup(); delta('部分'); projection.disconnect(); delta('旧连接');
  assert.equal(projection.view().needsSnapshot, true);
  assert.equal(projection.view().items[0]?.text, '部分');
});
test('turn completion uses full items and a late start or delta cannot reopen it', () => {
  const { projection, send, delta } = setup(); delta('部分');
  send('turn/completed', { turn: { id: 'turn', status: 'completed', items: [{ type: 'agentMessage', id: 'item', text: '完整' }] } });
  send('turn/started', { turn: { id: 'turn', status: 'inProgress' } }); delta('迟到');
  assert.equal(projection.view().turns[0]?.status, 'completed');
  assert.equal(projection.view().items[0]?.text, '完整');
});
test('failed turns retain failure and unknown item types remain explicit without exposing arguments', () => {
  const { projection, send } = setup();
  send('item/completed', { item: { type: 'futureSensitiveTool', id: 'i', arguments: { token: 'fixture-secret' } } });
  send('turn/completed', { turn: { id: 'turn', status: 'failed', items: [] } });
  const view = projection.view();
  assert.equal(view.turns[0]?.status, 'failed'); assert.equal(view.unsupportedItems, true);
  assert.equal(JSON.stringify(view).includes('fixture-secret'), false);
});
test('text limits are bounded, do not split emoji, and a final item can replace a clipped prefix', () => {
  const { projection, delta, finish } = setup({ itemText: 3 });
  delta('🙂🙂'); delta('suffix');
  assert.equal(projection.view().items[0]?.text, '🙂');
  assert.equal(projection.view().truncated, true);
  finish('OK');
  assert.equal(projection.view().items[0]?.text, 'OK');
  assert.equal(projection.view().items[0]?.truncated, false);
  assert.equal(projection.view().truncated, false);
});
test('aggregate text, item and turn budgets bound growth and visibly signal missing data', () => {
  const { projection, delta } = setup({ totalText: 5, items: 2, turns: 2 });
  delta('abcd'); delta('efgh', { itemId: 'second' }); delta('third', { itemId: 'third' });
  delta('new-turn', { turnId: 't2' }); delta('excess-turn', { turnId: 't3' });
  const view = projection.view();
  assert.equal(view.items.length, 2); assert.equal(view.turns.length, 2);
  assert.ok(view.items.reduce((sum, item) => sum + item.text.length, 0) <= 5);
  assert.equal(view.truncated, true);
});
test('snapshot replacement drops orphaned old items and rejects a stale sequence', () => {
  const { projection, delta } = setup(); delta('旧');
  assert.throws(() => projection.replaceSnapshot(1, 0, []), /STALE_SNAPSHOT/);
  projection.replaceSnapshot(1, 1, []); assert.deepEqual(projection.view().items, []);
});
test('plain-text views keep markup inert and hide reasoning, tool secrets and local image paths', () => {
  assert.equal(itemView('t', { type: 'agentMessage', id: 'a', text: '<img src=x onerror=alert(1)>' }, true)?.text, '<img src=x onerror=alert(1)>');
  for (const item of [
    { type: 'reasoning', id: 'r', content: ['fixture-secret'] },
    { type: 'mcpToolCall', id: 'm', server: 'server', tool: 'tool', arguments: { token: 'fixture-secret' } },
    { type: 'imageView', id: 'i', path: 'fixture-secret' },
  ]) assert.equal(JSON.stringify(itemView('t', item, true)).includes('fixture-secret'), false);
});
test('view consumers cannot mutate the next projection or advance an old epoch', () => {
  const { projection, delta } = setup(); delta('original');
  projection.view().items[0]!.text = 'changed';
  assert.equal(projection.view().items[0]?.text, 'original');
  assert.throws(() => projection.reconnect(1), /STALE_CONNECTION_EPOCH/);
});
