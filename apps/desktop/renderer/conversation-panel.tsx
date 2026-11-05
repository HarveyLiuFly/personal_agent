import React, { useEffect, useRef, useState } from 'react';
import type {
  HostResult,
  InteractionView,
  ProjectView,
  RunView,
  VerificationView,
} from '../../../packages/contracts/src/views.ts';
import type { ConversationSummary } from '../../../packages/contracts/src/conversations.ts';
import { InteractionCard } from './interactions.tsx';
import { AgentToolPanel } from './tool-panel.tsx';
import { isToolItem } from './tool-activity.ts';
import {
  displayMessage,
  mergeTurns,
  runStatusLabel,
  sendFailure,
  sendOnEnter,
} from './ui-model.ts';
import { MessageBody } from './message-body.tsx';
import { useDraft } from './drafts.ts';
import { subscribeRefresh } from './host-events.ts';

async function value<T>(request: Promise<HostResult<T>>): Promise<T> {
  const result = await request;
  if (!result.ok) throw Error(result.errorCode);
  return result.value;
}
const activeStates = ['preparing', 'submitting', 'running', 'waiting_input', 'waiting_approval'];
const ended = (run: RunView) => ['completed', 'failed', 'cancelled'].includes(run.status);

interface Props {
  project: ProjectView;
  /** The open conversation; none starts a new one with the first message. */
  conversationId?: string;
  disabled?: boolean;
  canCode?: boolean;
  onCreated?: (conversationId: string) => void;
}

/**
 * One conversation: every turn in order (older ones on request), the running turn live, and a
 * composer that continues the conversation whenever its latest turn has ended.
 */
export function ConversationPanel({
  project,
  conversationId,
  disabled = false,
  canCode = false,
  onCreated,
}: Props) {
  const [summary, setSummary] = useState<ConversationSummary>(),
    [recent, setRecent] = useState<RunView[]>([]),
    [older, setOlder] = useState<RunView[]>([]),
    [olderCursor, setOlderCursor] = useState<string | null>(null),
    [requests, setRequests] = useState<InteractionView[]>([]),
    [review, setReview] = useState<VerificationView>(),
    [checkpoint, setCheckpoint] = useState<string>();
  const [draft, setDraft] = useDraft(project.id + ':' + (conversationId ?? 'new')),
    [sending, setSending] = useState(false),
    [error, setError] = useState(''),
    [uncertain, setUncertain] = useState(false),
    [stopping, setStopping] = useState(false),
    [verifying, setVerifying] = useState(false),
    [checking, setChecking] = useState(false),
    [rolling, setRolling] = useState(false),
    [loadingOlder, setLoadingOlder] = useState(false);
  const [codeEnabled, setCodeEnabled] = useState(false),
    [target, setTarget] = useState(''),
    [paths, setPaths] = useState('');
  const key = useRef<string | undefined>(undefined),
    alive = useRef(true),
    seen = useRef({ turns: -1, latest: '' }),
    scroller = useRef<HTMLDivElement>(null),
    atEnd = useRef(true),
    input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    setSummary(undefined);
    setRecent([]);
    setOlder([]);
    setOlderCursor(null);
    setRequests([]);
    setReview(undefined);
    setCheckpoint(undefined);
    setError('');
    setUncertain(false);
    setStopping(false);
    key.current = undefined;
    seen.current = { turns: -1, latest: '' };
    atEnd.current = true;
    if (!conversationId) return;
    let stopped = false;
    const scope = { projectId: project.id, conversationId };
    async function refresh() {
      try {
        const next = await value(window.personalAgent.getConversation(scope));
        if (stopped) return;
        setSummary(next);
        if (next.turns !== seen.current.turns || (next.latestRunId ?? '') !== seen.current.latest) {
          const page = await value(window.personalAgent.listConversationTurns(scope));
          if (stopped) return;
          const first = seen.current.turns < 0;
          seen.current = { turns: next.turns, latest: next.latestRunId ?? '' };
          setRecent(page.items);
          if (first) setOlderCursor(page.nextCursor);
        } else if (next.latestRunId) {
          // Same turns: only the latest one can still change.
          const run = await value(
            window.personalAgent.getRun({ projectId: project.id, runId: next.latestRunId }),
          );
          if (stopped) return;
          setRecent((rows) => rows.map((row) => (row.runId === run.runId ? run : row)));
        }
        if (next.activeRunId) {
          const pending = await value(
            window.personalAgent.listInteractions({
              projectId: project.id,
              runId: next.activeRunId,
            }),
          );
          if (!stopped) setRequests(pending.filter((request) => request.state === 'pending'));
        } else setRequests([]);
        if (!next.activeRunId) setStopping(false);
        if (next.unread && document.visibilityState === 'visible')
          void window.personalAgent.updateConversation({ ...scope, read: true });
      } catch (cause) {
        if (!stopped)
          setError(
            cause instanceof Error && /CONVERSATION_NOT_FOUND/.test(cause.message)
              ? '找不到这个对话，它可能已被遗忘。'
              : '暂时无法更新这个对话。输入已保留。',
          );
      }
    }
    // Re-read after each Host change notice instead of polling.
    const unsubscribe = subscribeRefresh(refresh);
    return () => {
      stopped = true;
      unsubscribe();
    };
  }, [project.id, conversationId]);

  const turns = mergeTurns(older, recent),
    latest = turns.at(-1),
    latestEnded = Boolean(latest && ended(latest));
  // Code review and resume checkpoint belong to the latest ended turn.
  useEffect(() => {
    let stopped = false;
    setReview(undefined);
    setCheckpoint(undefined);
    if (!latest || !latestEnded) return;
    const runId = latest.runId;
    if (latest.mode === 'workspaceWrite')
      void value(window.personalAgent.getVerification({ projectId: project.id, runId }))
        .then((r) => {
          if (!stopped) setReview(r.target ? r : undefined);
        })
        .catch(() => undefined);
    void value(window.personalAgent.getRunCheckpoint({ projectId: project.id, runId }))
      .then((cp) => {
        if (!stopped) setCheckpoint(cp.checkpointId ?? undefined);
      })
      .catch(() => undefined);
    return () => {
      stopped = true;
    };
  }, [project.id, latest?.runId, latest?.status]);
  const stamp = turns
    .map((run) => run.runId + ':' + (run.snapshot?.items.map((i) => i.text.length).join(',') ?? ''))
    .join('|');
  useEffect(() => {
    if (scroller.current && atEnd.current)
      scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [stamp, requests.length, review?.diff]);

  const runningHere = Boolean(summary?.activeRunId),
    notStarted = Boolean(summary && !summary.latestRunId),
    codeReady = !codeEnabled || Boolean(target.trim() && paths.trim()),
    canSend =
      !disabled &&
      !sending &&
      !runningHere &&
      !notStarted &&
      Boolean(draft.trim()) &&
      (conversationId ? Boolean(summary?.latestRunId) : codeReady);

  async function send() {
    if (!canSend) return;
    setSending(true);
    setError('');
    key.current ??= crypto.randomUUID();
    const text = draft;
    try {
      const run = await value(
        conversationId
          ? window.personalAgent.continueRun({
              projectId: project.id,
              runId: summary!.latestRunId!,
              text,
              submissionKey: key.current,
            })
          : window.personalAgent.submitMessage({
              projectId: project.id,
              text,
              submissionKey: key.current,
              ...(codeEnabled
                ? {
                    code: {
                      profile: 'node-test',
                      target: target.trim(),
                      allowedPaths: paths
                        .split(/[\n,]/)
                        .map((p) => p.trim())
                        .filter(Boolean),
                    },
                  }
                : {}),
            }),
      );
      if (!alive.current) return;
      setDraft('');
      key.current = undefined;
      setUncertain(false);
      atEnd.current = true;
      if (!conversationId) onCreated?.(run.taskId);
    } catch (cause) {
      if (!alive.current) return;
      const failure = sendFailure(cause instanceof Error ? cause.message : '');
      setError(failure.message);
      setUncertain(failure.retry);
      // A known refusal sent nothing; an unconfirmed one keeps its key so a retry cannot repeat it.
      if (!failure.retry) key.current = undefined;
    } finally {
      if (alive.current) setSending(false);
    }
  }
  async function start() {
    if (!summary || sending) return;
    setSending(true);
    setError('');
    key.current ??= crypto.randomUUID();
    try {
      await value(
        window.personalAgent.startTask({
          projectId: project.id,
          taskId: summary.conversationId,
          expectedVersion: summary.version,
          submissionKey: key.current,
        }),
      );
      key.current = undefined;
    } catch (cause) {
      const failure = sendFailure(cause instanceof Error ? cause.message : '');
      if (alive.current) setError(failure.message);
    } finally {
      if (alive.current) setSending(false);
    }
  }
  async function loadOlder() {
    if (!conversationId || !olderCursor || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const page = await value(
        window.personalAgent.listConversationTurns({
          projectId: project.id,
          conversationId,
          cursor: olderCursor,
        }),
      );
      if (!alive.current) return;
      atEnd.current = false;
      setOlder((rows) => [...rows, ...page.items]);
      setOlderCursor(page.nextCursor);
    } catch {
      if (alive.current) setError('暂时无法读取更早的对话。');
    } finally {
      if (alive.current) setLoadingOlder(false);
    }
  }
  async function verify(run: RunView) {
    if (verifying) return;
    setVerifying(true);
    try {
      const next = await value(
        window.personalAgent.verifyRun({ projectId: project.id, runId: run.runId }),
      );
      if (alive.current) setReview(next);
    } catch {
      if (alive.current) setError('验证未完成，变更仍需审阅。');
    } finally {
      if (alive.current) setVerifying(false);
    }
  }
  function messages(run: RunView) {
    const items = run.snapshot?.items.filter((i) => !isToolItem(i) && i.kind !== 'reasoning');
    if (!items?.length)
      return activeStates.includes(run.status) ? null : (
        <p className="muted turn-empty">这一轮没有保存内容。</p>
      );
    return items.map((item) => (
      <article
        key={run.runId + ':' + item.id}
        className={'message ' + item.role}
        data-execution-item={item.id}
        data-item-status={item.status}
      >
        <small>
          {item.role === 'user' ? '你' : item.role === 'assistant' ? 'Personal Agent' : item.label}
        </small>
        <MessageBody text={displayMessage(item)} />
        {item.truncated && <small>仅显示部分内容</small>}
      </article>
    ));
  }
  function turn(run: RunView) {
    const isLatest = run.runId === latest?.runId,
      active = activeStates.includes(run.status);
    return (
      <section
        key={run.runId}
        className="conversation-turn"
        data-turn-run={run.runId}
        data-run-status={run.status}
      >
        {messages(run)}
        {(active || run.status !== 'completed') && (
          <div className="run-toolbar">
            <span className={'badge ' + run.taskStatus} role="status">
              {runStatusLabel(run)}
            </span>
            {isLatest && active && (
              <button
                className="stop-button"
                data-action="interrupt-run"
                disabled={stopping}
                onClick={() => {
                  setStopping(true);
                  void value(
                    window.personalAgent.interruptRun({ projectId: project.id, runId: run.runId }),
                  ).catch(() => {
                    setStopping(false);
                    setError('停止尚未确认，请稍后再看。');
                  });
                }}
              >
                {stopping ? '正在停止…' : '停止'}
              </button>
            )}
          </div>
        )}
        {run.errorCode && ['failed', 'outcome_unknown'].includes(run.status) && (
          <p className="notice error">
            {run.errorCode === 'RUN_NOT_SENT'
              ? '这一轮没有发送到模型，可以直接再发一次。'
              : run.status === 'outcome_unknown'
                ? '这一轮的结果还没有确认。应用会在 Codex 记录里自动核对，确认前不会重发。'
                : '这一轮没有完成。'}
            <details className="technical">
              <summary>原因详情</summary>
              {run.errorCode}
            </details>
          </p>
        )}
        {isLatest && run.snapshot?.needsSnapshot && (
          <p className="notice">连接中断，当前显示最后保存的内容。</p>
        )}
        {isLatest &&
          requests.map((request) => (
            <InteractionCard
              key={request.requestId}
              request={request}
              reply={async (decision, answers) => {
                await value(
                  window.personalAgent.replyInteraction({
                    projectId: project.id,
                    runId: run.runId,
                    requestId: request.requestId,
                    decision,
                    ...(answers ? { answers } : {}),
                  }),
                );
                if (alive.current)
                  setRequests((rows) => rows.filter((r) => r.requestId !== request.requestId));
              }}
            />
          ))}
        {isLatest && run.status === 'outcome_unknown' && (
          <div className="notice">
            正在自动核对这一轮的结果，确认后可以继续这个对话；也可以现在手动核对。
            <button
              data-action="reconcile-run"
              disabled={checking}
              onClick={() => {
                setChecking(true);
                void value(
                  window.personalAgent.reconcileRun({ projectId: project.id, runId: run.runId }),
                )
                  .then(() => setError(''))
                  .catch(() => setError('现有记录还不足以确认结果，不会重复发送。'))
                  .finally(() => setChecking(false));
              }}
            >
              {checking ? '核对中…' : '核对结果'}
            </button>
          </div>
        )}
        {isLatest && review && (
          <article
            className="review-card"
            data-verification-status={review.receipt?.status ?? 'pending'}
          >
            <div className="page-heading">
              <div>
                <h3>变更与验证</h3>
                <p className="muted">
                  {review.changedFiles.length} 个变更文件 · {review.target}
                </p>
              </div>
              <button
                data-action="verify-run"
                disabled={
                  verifying || run.status !== 'completed' || run.taskStatus !== 'needs_review'
                }
                onClick={() => void verify(run)}
              >
                {verifying
                  ? '正在验证…'
                  : review.receipt?.status === 'passed'
                    ? '验证已通过'
                    : '运行验证'}
              </button>
            </div>
            {review.receipt && (
              <p
                role="status"
                className={review.receipt.status === 'passed' ? 'success-text' : 'notice'}
              >
                {review.receipt.status === 'passed' ? '验证通过' : '验证未通过'} · 实际执行{' '}
                {review.receipt.executed} / 发现 {review.receipt.discovered} · 跳过{' '}
                {review.receipt.skipped}
              </p>
            )}
            <pre data-run-diff>{review.diff || '当前没有文件变更。'}</pre>
            {review.diffTruncated && <small>仅显示部分差异</small>}
          </article>
        )}
        {(run.snapshot?.items.some(isToolItem) || (isLatest && active)) && (
          <details className="work-log">
            <summary>查看执行过程</summary>
            <AgentToolPanel key={run.runId} run={run} />
          </details>
        )}
      </section>
    );
  }
  const grantExpired = /遗忘过记忆/.test(error);
  return (
    <section
      className="conversation task-conversation"
      data-execution-panel
      data-conversation-panel
      data-conversation-id={conversationId ?? ''}
      data-current-run={latest?.runId}
    >
      <div
        className="conversation-scroll"
        ref={scroller}
        onScroll={() => {
          const n = scroller.current;
          if (n) atEnd.current = n.scrollHeight - n.scrollTop - n.clientHeight < 90;
        }}
      >
        {!conversationId && (
          <div className="conversation-empty">
            <span className="assistant-mark">P</span>
            <h2>把下一件事交给我</h2>
            <p>问一个关于这个项目的问题，之后可以在同一个对话里接着问。</p>
            <div className="prompt-starters">
              <button
                className="secondary"
                onClick={() => setDraft('概括这个项目的结构和用途，不修改文件。')}
              >
                了解这个项目 ↗
              </button>
              {canCode && (
                <button
                  className="secondary"
                  onClick={() => {
                    setCodeEnabled(true);
                    input.current?.focus();
                  }}
                >
                  修改代码 ↗
                </button>
              )}
            </div>
          </div>
        )}
        {conversationId && summary && (
          <div className="conversation-head">
            <span className="muted">{summary.turns} 轮</span>
            <button
              className="text-button"
              data-action="pin-conversation"
              aria-pressed={summary.pinned}
              onClick={() =>
                void value(
                  window.personalAgent.updateConversation({
                    projectId: project.id,
                    conversationId,
                    pinned: !summary.pinned,
                  }),
                )
                  .then(setSummary)
                  .catch(() => setError('暂时无法置顶。'))
              }
            >
              {summary.pinned ? '取消置顶' : '置顶'}
            </button>
          </div>
        )}
        {olderCursor && (
          <button
            className="text-button load-older"
            data-action="load-older-turns"
            disabled={loadingOlder}
            onClick={() => void loadOlder()}
          >
            {loadingOlder ? '正在读取…' : '显示更早的对话'}
          </button>
        )}
        <div className="items" data-execution-items>
          {turns.map(turn)}
        </div>
        {notStarted && (
          <div className="notice">
            这个对话还没有开始。
            <button
              data-action="start-conversation"
              disabled={sending}
              onClick={() => void start()}
            >
              {sending ? '正在开始…' : '开始'}
            </button>
          </div>
        )}
        {grantExpired && checkpoint && latest && (
          <div className="notice">
            <button
              data-action="rollover-run"
              disabled={rolling || runningHere}
              onClick={() => {
                setRolling(true);
                void value(
                  window.personalAgent.rolloverRun({
                    projectId: project.id,
                    runId: latest.runId,
                    checkpointId: checkpoint,
                    submissionKey: crypto.randomUUID(),
                  }),
                )
                  .then(() => setError(''))
                  .catch(() => setError('新线程尚未确认，请稍后再看。'))
                  .finally(() => setRolling(false));
              }}
            >
              {rolling ? '正在新开…' : '从检查点新开线程'}
            </button>
          </div>
        )}
      </div>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      {canCode && !conversationId && (
        <div className="execution-scope">
          <label>
            对话方式
            <select
              data-code-profile
              aria-label="对话方式"
              value={codeEnabled ? 'code' : 'read'}
              disabled={sending}
              onChange={(e) => {
                setCodeEnabled(e.target.value === 'code');
                key.current = undefined;
              }}
            >
              <option value="read">只读</option>
              <option value="code">修改代码</option>
            </select>
          </label>
          {codeEnabled && (
            <div className="code-options">
              <label>
                验证测试文件
                <input
                  data-code-target
                  value={target}
                  disabled={sending}
                  placeholder="test/math.test.mjs"
                  onChange={(e) => {
                    setTarget(e.target.value);
                    key.current = undefined;
                  }}
                />
              </label>
              <label>
                允许修改的文件
                <input
                  data-code-paths
                  value={paths}
                  disabled={sending}
                  placeholder="src/math.mjs，多项用逗号分隔"
                  onChange={(e) => {
                    setPaths(e.target.value);
                    key.current = undefined;
                  }}
                />
              </label>
            </div>
          )}
        </div>
      )}
      <footer className="composer task-composer">
        <textarea
          ref={input}
          aria-label="消息"
          data-task-draft
          value={draft}
          maxLength={32768}
          disabled={disabled || sending || notStarted}
          onChange={(e) => {
            setDraft(e.target.value);
            // An unconfirmed send keeps its key: resending can never deliver it twice.
            if (!uncertain) key.current = undefined;
          }}
          onKeyDown={(e) => {
            if (sendOnEnter(e)) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder={
            runningHere
              ? '正在运行，可以先写下一条…'
              : conversationId
                ? '继续这个对话…'
                : codeEnabled
                  ? '描述希望完成的修改…'
                  : '提一个关于这个项目的问题…'
          }
          rows={3}
        />
        <div className="composer-tools">
          <span className="muted">
            {runningHere
              ? summary?.attention === 'unknown'
                ? '先核对上一轮的结果'
                : '这一轮结束后可以继续'
              : (latest?.mode ?? (codeEnabled ? 'workspaceWrite' : 'readOnly')) === 'workspaceWrite'
                ? '仅修改指定文件'
                : '只读访问项目'}
          </span>
          <button data-action="send" disabled={!canSend} onClick={() => void send()}>
            {sending ? '正在发送…' : uncertain ? '再次发送' : '发送 ↑'}
          </button>
        </div>
      </footer>
      <p className="composer-hint">Enter 发送 · Shift + Enter 换行</p>
    </section>
  );
}
