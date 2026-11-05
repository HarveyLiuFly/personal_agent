import { createInterface } from 'node:readline';
const cwd = process.argv[2];
const send = (id: unknown, result: unknown) =>
  process.stdout.write(JSON.stringify({ id, result }) + '\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line) as {
    id?: number;
    method: string;
    params?: Record<string, unknown>;
  };
  const p = request.params ?? {};
  if (request.method === 'initialized') return;
  if (request.method === 'initialize') {
    send(request.id, { userAgent: 'local-history-fixture' });
    return;
  }
  if (request.method === 'thread/list') {
    send(request.id, {
      data: [
        {
          id: p.cursor ? 'fixture-thread-2' : 'fixture-thread-1',
          cwd,
          name: p.cursor ? '第二页 Fixture' : '历史浏览 Fixture（合成记录）',
          updatedAt: 1,
          status: { type: 'idle' },
        },
      ],
      nextCursor: p.cursor ? null : 'native-fixture-page-2',
    });
    return;
  }
  if (request.method === 'thread/read') {
    send(request.id, { thread: { id: p.threadId, cwd, historyMode: 'paginated' } });
    return;
  }
  if (request.method === 'thread/turns/list') {
    send(request.id, {
      data: [{ id: 'fixture-turn-1', status: 'completed', items: [] }],
      nextCursor: null,
    });
    return;
  }
  if (request.method === 'thread/items/list') {
    const items = [
      {
        type: 'userMessage',
        id: 'fixture-user',
        content: [{ type: 'text', text: '请查看这份合成历史记录。' }],
      },
      {
        type: 'agentMessage',
        id: 'fixture-assistant',
        text: '历史浏览 Fixture：<img src=x onerror="window.__fixtureExecuted=true">',
      },
      {
        type: 'commandExecution',
        id: 'fixture-command',
        command: 'node --test fixture.test.js',
        aggregatedOutput: '3 tests passed (synthetic fixture)',
        arguments: { token: 'fixture-private-field' },
      },
    ];
    send(request.id, { data: items.map((item) => ({ turnId: p.turnId, item })), nextCursor: null });
    return;
  }
  process.stdout.write(
    JSON.stringify({
      id: request.id,
      error: { code: -32601, message: 'Fixture supports read-only history methods only' },
    }) + '\n',
  );
});
