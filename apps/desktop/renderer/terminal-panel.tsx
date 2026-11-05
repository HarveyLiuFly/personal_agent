import { TerminalInputQueue } from './terminal-input.ts';
import React, { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import type { ProjectView, HostResult } from '../../../packages/contracts/src/views.ts';
import type { TerminalView } from '../../../packages/contracts/src/terminal.ts';
async function value<T>(p: Promise<HostResult<T>>) {
  const r = await p;
  if (!r.ok) throw Error(r.errorCode);
  return r.value;
}
const labels: Record<string, string> = {
  prepared: '准备中',
  starting: '正在启动',
  running: '运行中',
  stopping: '正在停止',
  exited: '已结束',
  outcome_unknown: '结果待核对',
};
export function TerminalPanel({
  project,
  disabled,
  onBusyChange,
}: {
  project: ProjectView;
  disabled: boolean;
  onBusyChange: (busy: boolean) => void;
}) {
  const [view, setView] = useState<TerminalView>(),
    [error, setError] = useState<string>(),
    [busy, setBusy] = useState(false),
    [truncated, setTruncated] = useState(false);
  const element = useRef<HTMLDivElement>(null),
    terminal = useRef<Terminal | undefined>(undefined),
    alive = useRef(true),
    polling = useRef(false),
    cursor = useRef(0),
    session = useRef<TerminalView['session']>(null),
    inputQueue = useRef<TerminalInputQueue | undefined>(undefined),
    operationPending = useRef(false);
  if (!inputQueue.current)
    inputQueue.current = new TerminalInputQueue(
      (q) => value(window.personalAgent.writeTerminal(q)),
      (id) => {
        if (alive.current && session.current?.sessionId === id) {
          if (terminal.current) terminal.current.options.disableStdin = true;
          setError('TERMINAL_INPUT_UNKNOWN');
        }
      },
      () => {
        if (alive.current) setError('TERMINAL_INPUT_TOO_LARGE');
      },
    );
  const update = (next: TerminalView) => {
    session.current = next.session;
    if (next.session)
      inputQueue.current!.bind(
        project.id,
        next.session.sessionId,
        next.session.lastInputSequence,
        next.session.state === 'running',
      );
    if (alive.current) setView(next);
    if (terminal.current)
      terminal.current.options.disableStdin =
        !next.session || !inputQueue.current!.writable(next.session.sessionId);
  };
  async function refresh() {
    if (polling.current) return;
    polling.current = true;
    try {
      const next = await value(
        window.personalAgent.readTerminal({ projectId: project.id, afterSequence: cursor.current }),
      );
      if (!alive.current) return;
      update(next);
      if (terminal.current) {
        if (next.reset) {
          terminal.current.reset();
          setTruncated(true);
        }
        for (const c of next.chunks)
          terminal.current.write(Uint8Array.from(atob(c.data), (v) => v.charCodeAt(0)));
        cursor.current = next.nextSequence;
      }
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : 'TERMINAL_UNAVAILABLE');
    } finally {
      polling.current = false;
    }
  }
  async function perform(work: () => Promise<void>) {
    if (operationPending.current) return;
    operationPending.current = true;
    setBusy(true);
    onBusyChange(true);
    setError(undefined);
    try {
      await work();
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : 'TERMINAL_UNAVAILABLE');
    } finally {
      operationPending.current = false;
      if (alive.current) {
        setBusy(false);
        onBusyChange(false);
      }
    }
  }
  useEffect(() => {
    alive.current = true;
    void refresh();
    const timer = setInterval(() => void refresh(), 250);
    return () => {
      alive.current = false;
      clearInterval(timer);
      inputQueue.current?.dispose();
      onBusyChange(false);
    };
  }, [project.id]);
  useEffect(() => {
    if (!view?.session || !element.current) return;
    const term = new Terminal({
      cols: view.session.cols,
      rows: view.session.rows,
      fontSize: 12,
      lineHeight: 1.2,
      scrollback: 1000,
      screenReaderMode: true,
      disableStdin: !inputQueue.current!.writable(view.session.sessionId),
      allowProposedApi: false,
      linkHandler: { activate: () => {} },
      theme: { background: '#0b1422', foreground: '#e7edf6', cursor: '#a2eedc' },
    });
    terminal.current = term;
    cursor.current = 0;
    term.open(element.current);
    const sourceSessionId = view.session.sessionId,
      listener = term.onData((text) => {
        void inputQueue.current!.submit(sourceSessionId, text);
      });
    void refresh();
    return () => {
      listener.dispose();
      term.dispose();
      if (terminal.current === term) terminal.current = undefined;
    };
  }, [view?.session?.sessionId]);
  const active = view?.session && !['exited'].includes(view.session.state),
    message =
      error === 'TERMINAL_INPUT_TOO_LARGE'
        ? '单次粘贴或待发送输入过长，本次输入未发送。'
        : error === 'WORKSPACE_BUSY'
          ? '项目正在执行任务或处理工作树，请稍后打开终端。'
          : error === 'TERMINAL_INPUT_UNKNOWN'
            ? '上次输入的送达状态未知，请核对输出；不会自动重发。'
            : error === 'TERMINAL_PROCESS_NOT_CONFIRMED_STOPPED'
              ? '尚未确认原会话进程已全部停止，请稍后核对。'
              : error
                ? `终端操作未完成（${error}）。`
                : '';
  return (
    <details className="terminal-panel" data-terminal-panel>
      <summary>
        用户终端{' '}
        <span className="badge">{view?.session ? labels[view.session.state] : '未启动'}</span>
      </summary>
      <p className="history-note">
        在当前工作区打开你的
        Shell。终端开启期间暂停本项目的模型执行与工作树操作；关闭窗口保留会话，退出应用停止会话。终端文本仅保留于内存。
      </p>
      {message && (
        <p className="notice error" role="alert" data-terminal-error={error}>
          {message}
        </p>
      )}
      {truncated && <p className="history-note">较早的输出已截断，仅显示内存中保留的内容。</p>}
      <div className="terminal-actions">
        {!active ? (
          <button
            data-action="open-terminal"
            disabled={busy || disabled}
            onClick={() =>
              void perform(async () => {
                cursor.current = 0;
                setTruncated(false);
                update(
                  await value(
                    window.personalAgent.openTerminal({
                      projectId: project.id,
                      commandKey: crypto.randomUUID(),
                      cols: 80,
                      rows: 24,
                    }),
                  ),
                );
              })
            }
          >
            打开用户终端
          </button>
        ) : (
          <>
            {view?.session?.state === 'running' && (
              <>
                <button
                  data-action="focus-terminal"
                  disabled={busy || disabled}
                  onClick={() => terminal.current?.focus()}
                >
                  输入命令
                </button>
                <button
                  data-action="resize-terminal"
                  disabled={busy || disabled}
                  onClick={() =>
                    void perform(async () => {
                      const s = session.current!;
                      await value(
                        window.personalAgent.resizeTerminal({
                          projectId: project.id,
                          sessionId: s.sessionId,
                          cols: 100,
                          rows: 30,
                        }),
                      );
                      terminal.current?.resize(100, 30);
                      await refresh();
                    })
                  }
                >
                  调整为 100 × 30
                </button>
                <button
                  data-action="close-terminal"
                  disabled={busy || disabled}
                  onClick={() =>
                    void perform(async () => {
                      const s = session.current!;
                      update(
                        await value(
                          window.personalAgent.closeTerminal({
                            projectId: project.id,
                            sessionId: s.sessionId,
                            commandKey: crypto.randomUUID(),
                          }),
                        ),
                      );
                    })
                  }
                >
                  关闭并停止会话
                </button>
              </>
            )}
            {view?.session?.state === 'outcome_unknown' && (
              <button
                data-action="reconcile-terminal"
                disabled={busy || disabled}
                onClick={() =>
                  void perform(async () => {
                    update(
                      await value(
                        window.personalAgent.reconcileTerminal({
                          projectId: project.id,
                          sessionId: session.current!.sessionId,
                        }),
                      ),
                    );
                  })
                }
              >
                核对已停止会话
              </button>
            )}
          </>
        )}
      </div>
      {view?.session && (
        <div
          ref={element}
          className="terminal-screen"
          data-terminal-screen
          data-terminal-session={view.session.sessionId}
        />
      )}
    </details>
  );
}
