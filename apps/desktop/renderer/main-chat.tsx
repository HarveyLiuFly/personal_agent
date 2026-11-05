import React, { useEffect, useRef, useState } from 'react';
import type { ProjectView, HostResult } from '../../../packages/contracts/src/views.ts';
import type { MainChatInput, MainChatView } from '../../../packages/contracts/src/chat.ts';
import type {
  ChatRouteView,
  ProposeMainChat,
  CommitChatRoute,
} from '../../../packages/contracts/src/routing.ts';
import {
  finishFreshDiscussion,
  sendOnEnter,
  operationLabels,
  routeResult,
  taskLabels,
  displayDiscussion,
} from './ui-model.ts';
import { MessageBody } from './message-body.tsx';
import { useDraft } from './drafts.ts';
import { subscribeRefresh, nextHostEvent } from './host-events.ts';
async function value<T>(work: Promise<HostResult<T>>) {
  const r = await work;
  if (!r.ok) throw Error(r.errorCode);
  return r.value;
}
type Correction = {
  projectId: string;
  planId: string;
  taskId: string;
  messageId: string;
  focusRevision: number;
};
type Request =
  | { kind: 'correct'; input: Correction }
  | { kind: 'rule'; input: MainChatInput }
  | { kind: 'propose'; input: ProposeMainChat }
  | { kind: 'commit'; input: CommitChatRoute };
const rejected = (error: unknown) =>
  error instanceof Error &&
  /^(CHAT_FOCUS_CHANGED|ROUTE_VERSION_CHANGED|ROUTE_CANDIDATE_CHANGED|ROUTE_CONTEXT_CHANGED|ROUTE_PLAN_UNAVAILABLE|ROUTE_PROJECT_MISMATCH|ROUTE_TASK_NOT_CANDIDATE|TASK_AUTHORIZATION_CHANGED|INVALID_ROUTE_INPUT|INVALID_ROUTE_COMMIT|IDEMPOTENCY_CONFLICT|INVALID_CHAT_INPUT)$/.test(
    error.message,
  );
export function MainChatWorkspace({
  project,
  onTask,
}: {
  project: ProjectView;
  onTask?: (taskId: string) => void;
}) {
  const alive = useRef(true),
    pending = useRef(false),
    unconfirmed = useRef<Request | undefined>(undefined),
    scroller = useRef<HTMLDivElement>(null),
    atEnd = useRef(true);
  const [view, setView] = useState<MainChatView>(),
    [routes, setRoutes] = useState<ChatRouteView[]>([]),
    [text, setText] = useDraft(project.id + ':assistant'),
    [selected, setSelected] = useState(''),
    [busy, setBusy] = useState(false),
    [uncertain, setUncertain] = useState(false),
    [error, setError] = useState(''),
    [phase, setPhase] = useState(''),
    [corrections, setCorrections] = useState<Record<string, string>>({});
  async function refresh() {
    try {
      const [chat, current] = await Promise.all([
        value(window.personalAgent.readMainChat({ projectId: project.id })),
        value(window.personalAgent.listChatRoutes({ projectId: project.id })),
      ]);
      if (!alive.current) return;
      setView(chat);
      setRoutes(current);
      const request = unconfirmed.current;
      if (!pending.current && request) {
        const found = current.find((r) =>
          request.kind === 'propose'
            ? r.messageId === request.input.messageId
            : request.kind === 'commit' || request.kind === 'correct'
              ? r.id === request.input.planId
              : false,
        );
        if (
          (request.kind === 'rule' &&
            chat.messages.some((m) => m.messageId === request.input.messageId)) ||
          (found &&
            ((request.kind === 'propose' && found.routingRunId !== null) ||
              (request.kind === 'commit' &&
                ['committing', 'completed', 'failed', 'outcome_unknown'].includes(found.state)) ||
              (request.kind === 'correct' &&
                chat.messages.some(
                  (m) => m.messageId === request.input.messageId && m.reason === 'user_correction',
                ))))
        ) {
          unconfirmed.current = undefined;
          setUncertain(false);
          setError('');
        }
      }
    } catch {
      if (alive.current) setError((old) => old || '暂时无法读取对话。草稿已保留，请刷新核对。');
    }
  }
  useEffect(() => {
    alive.current = true;
    const unsubscribe = subscribeRefresh(refresh);
    return () => {
      alive.current = false;
      unsubscribe();
    };
  }, [project.id]);
  const contentStamp =
    view?.messages.length +
    ':' +
    routes.map((r) => r.id + ':' + r.version + ':' + r.state).join('|');
  useEffect(() => {
    if (scroller.current && atEnd.current)
      scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [contentStamp, busy]);
  async function execute(request: Request, fresh = false) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    unconfirmed.current = request;
    try {
      if (request.kind === 'rule') {
        await value(window.personalAgent.submitMainChat(request.input));
      } else if (request.kind === 'correct') {
        await value(window.personalAgent.correctChatRoute(request.input));
      } else if (request.kind === 'commit') {
        setPhase('正在处理已确认的操作…');
        await value(window.personalAgent.commitChatRoute(request.input));
      } else {
        setPhase('正在理解你的请求…');
        const route = await value(window.personalAgent.proposeMainChat(request.input));
        if (!alive.current) return;
        setRoutes((old) => [route, ...old.filter((r) => r.id !== route.id)]);
        if (fresh)
          await finishFreshDiscussion(route, {
            active: () => alive.current,
            wait: () => nextHostEvent('store', 5000),
            read: () => value(window.personalAgent.listChatRoutes({ projectId: project.id })),
            observe: (current) =>
              setRoutes((old) => [current, ...old.filter((r) => r.id !== current.id)]),
            commit: (current) => {
              const commit: Request = {
                kind: 'commit',
                input: {
                  projectId: project.id,
                  planId: current.id,
                  expectedVersion: current.version,
                },
              };
              unconfirmed.current = commit;
              setPhase('正在回答…');
              return value(window.personalAgent.commitChatRoute(commit.input));
            },
          });
      }
      if (alive.current) {
        if ((request.kind === 'rule' || request.kind === 'propose') && text === request.input.text)
          setText('');
        unconfirmed.current = undefined;
        setUncertain(false);
      }
    } catch (cause) {
      if (alive.current) {
        if (rejected(cause)) {
          unconfirmed.current = undefined;
          setUncertain(false);
          setError('任务或讨论对象已变化。这次操作未提交，请根据最新记录重新发送。');
        } else {
          setUncertain(true);
          setError('这次发送尚未确认。请核对原请求，避免重复发送。');
        }
      }
    } finally {
      pending.current = false;
      if (alive.current) {
        setBusy(false);
        setPhase('');
        void refresh();
      }
    }
  }
  function send() {
    if (!view || !text.trim() || busy || uncertain) return;
    atEnd.current = true;
    const input = {
      projectId: project.id,
      messageId: crypto.randomUUID(),
      text,
      focusRevision: view.focusRevision,
      ...(selected ? { taskId: selected } : {}),
    };
    void execute(
      { kind: /^\/(query|note|remember)\b/.test(text.trim()) ? 'rule' : 'propose', input },
      true,
    );
  }
  const messageIds = new Set(view?.messages.map((m) => m.messageId));
  const card = (route: ChatRouteView) => (
    <div
      className="route-card"
      data-route-id={route.id}
      data-route-state={route.state}
      key={route.id}
    >
      {route.plan?.question && <MessageBody text={route.plan.question} />}
      {route.state === 'proposing' && route.routingRunId && (
        <button
          className="text-button"
          onClick={() =>
            void value(
              window.personalAgent.interruptRun({
                projectId: project.id,
                runId: route.routingRunId!,
              }),
            ).catch(() => setError('停止结果需要核对。'))
          }
        >
          停止生成
        </button>
      )}
      {['prepared', 'proposing', 'committing'].includes(route.state) && (
        <p className="muted" role="status">
          {route.state === 'committing' ? '正在处理…' : '正在理解请求…'}
        </p>
      )}
      {route.steps.map((step) => (
        <div key={step.index} data-route-step-state={step.state} data-route-step-index={step.index}>
          {routeResult(step) ? (
            <div data-route-result>
              <MessageBody text={routeResult(step)!} />
            </div>
          ) : (
            <p>
              {operationLabels[step.operation.kind]}
              {step.operation.title ? ' · ' + step.operation.title : ''}
              {step.state === 'outcome_unknown'
                ? ' · 需要核对'
                : step.state === 'failed'
                  ? ' · 未完成'
                  : ''}
            </p>
          )}
          {step.state === 'pending' && step.operation.text && step.operation.kind !== 'CHAT' && (
            <p className="muted">{step.operation.text}</p>
          )}
          {step.taskId && onTask && !['CHAT', 'CLARIFY'].includes(step.operation.kind) && (
            <button className="text-button" onClick={() => onTask(step.taskId!)}>
              查看任务 →
            </button>
          )}
        </div>
      ))}
      {route.state === 'proposed' && route.steps.some((s) => s.operation.kind !== 'CLARIFY') && (
        <button
          data-action="commit-main-route"
          disabled={busy || uncertain}
          onClick={() =>
            void execute({
              kind: 'commit',
              input: { projectId: project.id, planId: route.id, expectedVersion: route.version },
            })
          }
        >
          确认并处理以上操作
        </button>
      )}
      {route.state === 'failed' && (
        <p role="status" className="muted">
          本次请求未完成，已有结果会保留。你可以调整要求后重新发送。
        </p>
      )}
      {route.state === 'outcome_unknown' && (
        <p className="notice">结果需要核对，系统不会自动重复执行。</p>
      )}
      <details className="technical">
        <summary>操作详情</summary>
        {view && ['proposed', 'completed', 'failed', 'corrected'].includes(route.state) && (
          <div>
            <label>
              更正讨论任务
              <select
                aria-label="更正讨论任务"
                value={corrections[route.id] ?? ''}
                disabled={busy || uncertain}
                onChange={(e) => setCorrections((old) => ({ ...old, [route.id]: e.target.value }))}
              >
                <option value="">选择任务</option>
                {view.tasks.map((task) => (
                  <option key={task.taskId} value={task.taskId}>
                    {task.title} · {task.taskId.slice(-6)}
                  </option>
                ))}
              </select>
            </label>
            <p>保留已发生结果，停止尚未派发的操作。</p>
            <button
              disabled={busy || uncertain || !corrections[route.id]}
              onClick={() =>
                void execute({
                  kind: 'correct',
                  input: {
                    projectId: project.id,
                    planId: route.id,
                    taskId: corrections[route.id]!,
                    messageId: crypto.randomUUID(),
                    focusRevision: view.focusRevision,
                  },
                })
              }
            >
              确认更正
            </button>
          </div>
        )}
        <p>
          状态 {route.state} · 记录 {route.id} · 版本 {route.version}
        </p>
        {route.steps.map((s) => (
          <p key={s.index}>
            {s.index + 1}. {operationLabels[s.operation.kind]} · {s.state}
            {s.operation.dependsOn.length
              ? ' · 依赖 ' + s.operation.dependsOn.map((n) => n + 1).join('、')
              : ''}
          </p>
        ))}
      </details>
    </div>
  );
  return (
    <section className="conversation" data-main-chat aria-label="Dot">
      <div
        className="conversation-scroll main-chat-entries"
        ref={scroller}
        onScroll={() => {
          const n = scroller.current;
          if (n) atEnd.current = n.scrollHeight - n.scrollTop - n.clientHeight < 90;
        }}
      >
        {!view?.messages.length && (
          <div className="conversation-empty">
            <span className="assistant-mark">P</span>
            <h2>今天想一起完成什么？</h2>
            <p>讨论想法、了解项目，或把接下来的工作交给我。</p>
            <div className="prompt-starters">
              {['概括这个项目的用途', '帮我梳理接下来的工作', '查询当前任务的进展'].map((t) => (
                <button className="secondary" key={t} onClick={() => setText(t)}>
                  {t} ↗
                </button>
              ))}
            </div>
          </div>
        )}
        {view?.messages.map((message) => {
          const route = routes.find((r) => r.messageId === message.messageId);
          return (
            <div
              className="exchange"
              key={message.messageId}
              data-chat-message={message.messageId}
              data-chat-kind={message.kind}
            >
              <article className="message user">
                <small>你</small>
                <div data-chat-user-text>
                  <MessageBody text={displayDiscussion(message.text)} />
                </div>
              </article>
              <article className="message assistant">
                <small>Personal Agent</small>
                {route ? (
                  card(route)
                ) : message.kind === 'query' && message.task ? (
                  <p data-chat-task-result>
                    {message.task.title} · {taskLabels[message.task.status]}
                  </p>
                ) : message.kind === 'note' ? (
                  <p className="muted">已保存这条笔记。</p>
                ) : message.text.startsWith('/remember') ? (
                  <p className="muted">确认来源已保存，可在记忆中使用。</p>
                ) : (
                  <p className="muted">
                    {message.reason === 'user_correction'
                      ? '讨论对象已更正。'
                      : '这条历史讨论已保存。'}
                  </p>
                )}
              </article>
            </div>
          );
        })}
        {routes
          .filter(
            (r) =>
              !messageIds.has(r.messageId) &&
              ['proposed', 'prepared', 'proposing', 'outcome_unknown'].includes(r.state),
          )
          .map(card)}
        {view?.pending
          .filter((p) => p.choices.length > 0)
          .map((p) => (
            <div className="route-card" key={p.id} data-chat-pending={p.id}>
              <p>要查看哪个任务？</p>
              {p.choices.map((c) => (
                <button
                  data-chat-choice={c.taskId}
                  key={c.taskId}
                  className="secondary"
                  disabled={busy || uncertain}
                  onClick={() =>
                    void execute({
                      kind: 'rule',
                      input: {
                        projectId: project.id,
                        messageId: crypto.randomUUID(),
                        text: '/query',
                        focusRevision: view.focusRevision,
                        pendingInteractionId: p.id,
                        taskId: c.taskId,
                      },
                    })
                  }
                >
                  {c.title} · {c.taskId.slice(-6)}
                </button>
              ))}
            </div>
          ))}
        {busy && (
          <p className="working" role="status">
            <span className="status-dot" />
            {phase || '正在保存…'}
          </p>
        )}
      </div>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      <div className="assistant-composer composer">
        <textarea
          aria-label="消息输入"
          data-chat-draft
          data-route-draft
          value={text}
          maxLength={8192}
          disabled={busy || uncertain}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (sendOnEnter(e)) {
              e.preventDefault();
              send();
            }
          }}
          placeholder="问点什么，或描述你想完成的事…"
          rows={3}
        />
        <div className="composer-tools">
          <select
            aria-label="讨论对象"
            value={selected}
            disabled={busy || uncertain}
            onChange={(e) => setSelected(e.target.value)}
          >
            <option value="">{view?.focus ? '当前：' + view.focus.task.title : '整个项目'}</option>
            {view?.tasks.map((t) => (
              <option key={t.taskId} value={t.taskId}>
                {t.title} · {t.taskId.slice(-6)}
              </option>
            ))}
          </select>
          <button
            className="text-button"
            data-action="refresh-main-chat"
            disabled={busy}
            onClick={() => void refresh()}
          >
            刷新
          </button>
          {uncertain ? (
            <button
              disabled={busy}
              onClick={() => {
                if (unconfirmed.current) void execute(unconfirmed.current);
              }}
            >
              核对这次发送
            </button>
          ) : (
            <button
              data-action="send-main-chat"
              disabled={busy || !view || !text.trim()}
              onClick={send}
            >
              {busy ? '处理中…' : '发送 ↑'}
            </button>
          )}
        </div>
      </div>
      <p className="composer-hint">Enter 发送 · Shift + Enter 换行 · 涉及任务变更时会先展示计划</p>
    </section>
  );
}
export function MainChatDialog({
  project,
  onClose,
}: {
  project: ProjectView;
  onClose: () => void;
}) {
  return (
    <>
      <button onClick={onClose}>返回</button>
      <MainChatWorkspace project={project} />
    </>
  );
}
