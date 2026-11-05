import React, { useEffect, useState } from 'react';
import type {
  HostResult,
  ItemView,
  Page,
  ProjectView,
  ThreadSummary,
  TurnView,
} from '../../../packages/contracts/src/views.ts';
import { displayMessage } from './ui-model.ts';
import { MessageBody } from './message-body.tsx';
import { subscribeRefresh } from './host-events.ts';

async function value<T>(request: Promise<HostResult<T>>) {
  const result = await request;
  if (!result.ok) throw Error(result.errorCode);
  return result.value;
}

/** Read-only browser of the threads Codex saved for a project; it never starts the model. */
export function NativeHistory({ project }: { project: ProjectView }) {
  const [threads, setThreads] = useState<Page<ThreadSummary>>(),
    [thread, setThread] = useState<ThreadSummary>(),
    [turns, setTurns] = useState<Page<TurnView>>(),
    [turn, setTurn] = useState<TurnView>(),
    [items, setItems] = useState<Page<ItemView>>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function perform(work: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await work();
    } catch {
      setError('暂时无法读取 Codex 历史。');
    } finally {
      setBusy(false);
    }
  }
  async function readThreads(cursor?: string) {
    setThreads(
      await value(
        window.personalAgent.listThreads({ projectId: project.id, ...(cursor ? { cursor } : {}) }),
      ),
    );
  }
  // The Host answers from its cached first page and refreshes it in the background; re-read
  // when it reports the refresh.
  useEffect(
    () =>
      subscribeRefresh(() => readThreads().catch(() => setError('暂时无法读取 Codex 历史。')), {
        topics: ['history'],
        projectId: project.id,
      }),
    [project.id],
  );
  return (
    <section className="native-history">
      <div className="page-heading">
        <div>
          <h3>原生历史</h3>
          <p className="muted">查看 Codex 为这个项目保存的原始会话；这里不会启动模型。</p>
        </div>
        <button
          className="secondary"
          data-action="refresh-threads"
          disabled={busy}
          onClick={() => void perform(() => readThreads())}
        >
          刷新历史
        </button>
      </div>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      <div className="history-browser">
        <nav>
          {threads?.items.map((t) => (
            <button
              data-thread-id={t.id}
              key={t.id}
              className={thread?.id === t.id ? 'active' : ''}
              onClick={() =>
                void perform(async () => {
                  setThread(t);
                  setTurn(undefined);
                  setItems(undefined);
                  setTurns(
                    await value(
                      window.personalAgent.listTurns({ projectId: project.id, threadId: t.id }),
                    ),
                  );
                })
              }
            >
              {t.title.startsWith('{') ? '任务会话 · ' + t.id.slice(-6) : t.title}
            </button>
          ))}
          {threads?.items.length === 0 && <p className="muted">暂无已保存历史</p>}
          {threads?.nextCursor && (
            <button
              className="text-button"
              data-action="next-threads"
              onClick={() => void perform(() => readThreads(threads.nextCursor!))}
            >
              更多会话
            </button>
          )}
        </nav>
        <div>
          <div className="turn-list">
            {turns?.items.map((t) => (
              <button
                key={t.id}
                className="secondary"
                data-turn-id={t.id}
                onClick={() =>
                  void perform(async () => {
                    if (!thread) return;
                    setTurn(t);
                    setItems(
                      await value(
                        window.personalAgent.listItems({
                          projectId: project.id,
                          threadId: thread.id,
                          turnId: t.id,
                        }),
                      ),
                    );
                  })
                }
              >
                {t.status === 'completed' ? '已结束' : '记录'} · {t.id.slice(-6)}
              </button>
            ))}
            {turns?.nextCursor && thread && (
              <button
                className="text-button"
                onClick={() =>
                  void perform(async () => {
                    setTurns(
                      await value(
                        window.personalAgent.listTurns({
                          projectId: project.id,
                          threadId: thread.id,
                          cursor: turns.nextCursor!,
                        }),
                      ),
                    );
                  })
                }
              >
                更早轮次
              </button>
            )}
          </div>
          {!turn && <p className="empty-history">选择会话和轮次查看内容。</p>}
          <div data-history-items>
            {items?.items.map((i) => (
              <article
                className={'message ' + i.role}
                key={i.id}
                data-item-id={i.id}
                data-item-kind={i.kind}
              >
                <small>{i.label}</small>
                <MessageBody text={displayMessage(i)} />
                {i.truncated && <small>仅显示部分内容</small>}
              </article>
            ))}
          </div>
          {items?.nextCursor && thread && turn && (
            <button
              className="text-button"
              onClick={() =>
                void perform(async () => {
                  setItems(
                    await value(
                      window.personalAgent.listItems({
                        projectId: project.id,
                        threadId: thread.id,
                        turnId: turn.id,
                        cursor: items.nextCursor!,
                      }),
                    ),
                  );
                })
              }
            >
              更多记录
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
