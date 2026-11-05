import React, { useEffect, useRef, useState } from 'react';
import type {
  HostResult,
  ItemView,
  Page,
  ProjectView,
  ThreadSummary,
  TurnView,
} from '../../../packages/contracts/src/views.ts';
import type { ConversationSummary } from '../../../packages/contracts/src/conversations.ts';
import { MainChatWorkspace } from './main-chat.tsx';
import { AutonomyDialog } from './autonomy-manager.tsx';
import { ConversationPanel } from './conversation-panel.tsx';
import { WorkspacePanel } from './workspace-panel.tsx';
import { TaskManager } from './task-manager.tsx';
import { BackupManager } from './backup-manager.tsx';
import { ProjectSkillsDialog } from './skills-panel.tsx';
import { conversationMarker, displayMessage } from './ui-model.ts';
import { clearDrafts } from './drafts.ts';
import { MessageBody } from './message-body.tsx';
import { shortcutLabel } from './platform.ts';
import { subscribeRefresh } from './host-events.ts';
type Surface =
  | 'dot'
  | 'conversation'
  | 'tasks'
  | 'goals'
  | 'memory'
  | 'automation'
  | 'workspace'
  | 'settings'
  | 'history';
const titles: Record<Surface, string> = {
  dot: 'Dot',
  conversation: '新对话',
  tasks: '任务与计划',
  goals: '目标',
  memory: '记忆',
  automation: '自动化',
  workspace: '文件与变更',
  settings: '设置',
  history: '原生历史',
};
async function value<T>(request: Promise<HostResult<T>>) {
  const result = await request;
  if (!result.ok) throw Error(result.errorCode);
  return result.value;
}
export function HistoryApp({ children }: { children: React.ReactNode }) {
  const [projects, setProjects] = useState<ProjectView[]>([]),
    [project, setProject] = useState<ProjectView>(),
    [surface, setSurface] = useState<Surface>('conversation');
  const [cap, setCap] = useState({
    mode: 'readOnly' as 'readOnly' | 'workspaceWrite',
    canCode: false,
    canSubmit: false,
    canManageTasks: false,
    canBrowseWorkspace: false,
    canBrowseSkills: false,
    canUseTerminal: false,
    backgroundEnabled: false,
  });
  // Conversation list: pinned, then pages of the rest (all loaded pages are re-read on change).
  const [pinned, setPinned] = useState<ConversationSummary[]>([]),
    [listed, setListed] = useState<ConversationSummary[]>([]),
    [moreCursor, setMoreCursor] = useState<string | null>(null),
    [pages, setPages] = useState(1),
    [conversationId, setConversationId] = useState<string>(),
    [forkSource, setForkSource] = useState<{ runId: string; title: string }>(),
    [showArchived, setShowArchived] = useState(false),
    [newKey, setNewKey] = useState(0);
  const [threads, setThreads] = useState<Page<ThreadSummary>>(),
    [thread, setThread] = useState<ThreadSummary>(),
    [turns, setTurns] = useState<Page<TurnView>>(),
    [turn, setTurn] = useState<TurnView>(),
    [items, setItems] = useState<Page<ItemView>>();
  const [query, setQuery] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [skillsOpen, setSkillsOpen] = useState(false),
    [collapsed, setCollapsed] = useState(false),
    [workspaceOpen, setWorkspaceOpen] = useState(false);
  const lock = useRef(false),
    projectRef = useRef(project?.id),
    privacy = useRef<number | undefined>(undefined),
    search = useRef<HTMLInputElement>(null);
  projectRef.current = project?.id;
  async function perform(work: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      await work();
    } catch {
      setError('暂时无法完成此操作，请保留当前输入并重试。');
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  useEffect(() => {
    let stopped = false;
    void value(window.personalAgent.workspaceState())
      .then((state) => {
        if (!stopped) {
          setCap({ ...state, canBrowseSkills: state.canBrowseSkills === true });
          setProjects(state.projects);
          setProject(state.projects[0]);
        }
      })
      .catch(() => setError('暂时无法连接本机服务。'));
    return () => {
      stopped = true;
    };
  }, []);
  useEffect(() => {
    if (!project || !cap.canManageTasks) return;
    let stopped = false;
    const projectId = project.id,
      text = query.trim();
    async function refresh() {
      try {
        const scope = {
          projectId,
          ...(text ? { query: text } : {}),
          ...(showArchived ? { archived: true } : {}),
        };
        const first = await value(window.personalAgent.listConversations(scope));
        const rows = [...first.items];
        let cursor = first.nextCursor;
        for (let page = 1; page < pages && cursor; page++) {
          const next = await value(window.personalAgent.listConversations({ ...scope, cursor }));
          rows.push(...next.items);
          cursor = next.nextCursor;
        }
        const epochs = await value(window.personalAgent.memoryState());
        if (stopped) return;
        setPinned(first.pinned);
        setListed(rows);
        setMoreCursor(cursor);
        if (privacy.current !== undefined && privacy.current !== epochs.privacyEpoch) clearDrafts();
        privacy.current = epochs.privacyEpoch;
      } catch {
        /* retain last confirmed navigation */
      }
    }
    // Re-read after each Host change notice instead of polling.
    const unsubscribe = subscribeRefresh(refresh);
    return () => {
      stopped = true;
      unsubscribe();
    };
  }, [project?.id, cap.canManageTasks, query, pages, showArchived]);
  useEffect(() => {
    setPinned([]);
    setListed([]);
    setMoreCursor(null);
    setPages(1);
    setConversationId(undefined);
    setForkSource(undefined);
    setShowArchived(false);
  }, [project?.id]);
  function newConversation() {
    if (busy) return;
    setConversationId(undefined);
    setForkSource(undefined);
    setNewKey((k) => k + 1);
    setSurface('conversation');
  }
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      if (e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setCollapsed(false);
        search.current?.focus();
      } else if (e.key.toLowerCase() === 'n' && !busy && project) {
        e.preventDefault();
        newConversation();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [project?.id, busy]);
  function switchProject(next: ProjectView) {
    setProject(next);
    setSurface('conversation');
    setConversationId(undefined);
    setThread(undefined);
    setThreads(undefined);
    setItems(undefined);
    setQuery('');
  }
  function openConversation(id: string) {
    setConversationId(id);
    setForkSource(undefined);
    setSurface('conversation');
  }
  function forkConversation(source: { runId: string; title: string }) {
    if (busy) return;
    setConversationId(undefined);
    setForkSource(source);
    setNewKey((k) => k + 1);
    setSurface('conversation');
  }
  const choose = () =>
    perform(async () => {
      const selected = await value(window.personalAgent.chooseProject());
      if (selected) {
        setProjects((old) => [selected, ...old.filter((p) => p.id !== selected.id)]);
        switchProject(selected);
      }
    });
  async function readThreads(cursor?: string) {
    if (!project) return;
    setThreads(
      await value(
        window.personalAgent.listThreads({ projectId: project.id, ...(cursor ? { cursor } : {}) }),
      ),
    );
  }
  const conversations = [...pinned, ...listed],
    selected = conversations.find((c) => c.conversationId === conversationId);
  const navigate = (next: Surface) => {
    setSurface(next);
    setError('');
  };
  // The Host answers from its cached first page and refreshes it in the background; re-read
  // when it reports the refresh.
  useEffect(() => {
    if (surface !== 'history' || !project) return;
    return subscribeRefresh(
      () => readThreads().catch(() => setError('暂时无法读取 Codex 历史。')),
      { topics: ['history'], projectId: project.id },
    );
  }, [surface, project?.id]);
  return (
    <div className={'shell v2-shell' + (collapsed ? ' sidebar-collapsed' : '')}>
      <aside className="sidebar" aria-label="主导航">
        <div className="brand">
          <span className="brand-mark">P</span>
          <strong>Personal Agent</strong>
          <button className="icon-button" aria-label="收起侧栏" onClick={() => setCollapsed(true)}>
            ‹
          </button>
        </div>
        <div className="project-switcher">
          <select
            className="project-select"
            aria-label="已保存项目"
            disabled={busy}
            value={project?.id ?? ''}
            onChange={(e) => {
              const p = projects.find((p) => p.id === e.target.value);
              if (p) switchProject(p);
            }}
          >
            {!project && <option value="">选择项目</option>}
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <button
            data-action="choose-project"
            aria-label="打开项目"
            title="打开项目文件夹"
            className="icon-button"
            disabled={busy}
            onClick={() => void choose()}
          >
            ＋
          </button>
        </div>
        <button
          className={'dot-entry' + (surface === 'dot' ? ' active' : '')}
          data-action="open-main-chat"
          disabled={!project || busy}
          title="Dot：你的个人助手，可以帮你安排项目里的对话和待办"
          onClick={() => navigate('dot')}
        >
          <span className="dot-mark" aria-hidden="true">
            ●
          </span>
          Dot
          <small>个人助手</small>
        </button>
        <button
          className="new-chat"
          data-action="project-tasks"
          disabled={!project || busy || !cap.canSubmit}
          onClick={newConversation}
        >
          ＋ 新对话 <kbd>{shortcutLabel('n')}</kbd>
        </button>
        <div className="sidebar-search">
          <input
            ref={search}
            aria-label="搜索对话"
            placeholder="搜索对话…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPages(1);
            }}
          />
          <kbd>{shortcutLabel('k')}</kbd>
        </div>
        <div className="project-heading">
          <span>{showArchived ? '已归档' : '对话'}</span>
          <button
            className="text-button"
            data-action="toggle-archived"
            aria-pressed={showArchived}
            onClick={() => {
              setShowArchived((v) => !v);
              setPages(1);
            }}
          >
            {showArchived ? '返回' : '已归档'}
          </button>
        </div>
        <nav className="thread-list" aria-label="对话">
          {conversations.map((conversation) => {
            const marker = conversationMarker(conversation);
            return (
              <button
                key={conversation.conversationId}
                className={
                  'thread' +
                  (surface === 'conversation' && conversationId === conversation.conversationId
                    ? ' selected'
                    : '') +
                  (conversation.unread ? ' unread' : '')
                }
                data-task-id={conversation.conversationId}
                data-conversation-id={conversation.conversationId}
                data-run-id={conversation.latestRunId ?? undefined}
                onClick={() => openConversation(conversation.conversationId)}
              >
                <span className={'task-dot ' + marker.dot} />
                <span className="thread-name">
                  {conversation.pinned && (
                    <span className="pin-mark" aria-label="已置顶">
                      ★{' '}
                    </span>
                  )}
                  {conversation.title}
                </span>
                <small>{marker.label}</small>
              </button>
            );
          })}
          {moreCursor && (
            <button
              className="text-button more-conversations"
              data-action="more-conversations"
              onClick={() => setPages((n) => n + 1)}
            >
              更多对话
            </button>
          )}
          {project && !conversations.length && (
            <p className="empty-nav">
              {query ? '没有匹配的对话' : showArchived ? '没有已归档的对话' : '从一个问题开始。'}
            </p>
          )}
        </nav>
        <nav className="secondary-nav">
          {(['tasks', 'goals', 'memory', 'automation', 'settings'] as Surface[]).map((name) => (
            <button
              data-action={'open-' + name}
              key={name}
              className={surface === name ? 'active' : ''}
              disabled={!project}
              onClick={() => navigate(name)}
            >
              {titles[name]}
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">
          {children}
          <span className="muted">
            {cap.backgroundEnabled ? '本机运行 · 关窗继续' : '本机工作区'}
          </span>
        </div>
      </aside>
      <div className="workspace-area">
        <main className="app-main">
          <header className="toolbar">
            <div className="toolbar-title">
              {collapsed && (
                <button
                  className="icon-button"
                  aria-label="展开侧栏"
                  onClick={() => setCollapsed(false)}
                >
                  ☰
                </button>
              )}
              <span className="project-crumb">{project?.name ?? '工作区'}</span>
              <span className="crumb-separator">/</span>
              <h1>
                {surface === 'conversation'
                  ? conversationId
                    ? (selected?.title ?? '对话')
                    : forkSource
                      ? '从这里新开'
                      : '新对话'
                  : titles[surface]}
              </h1>
            </div>
            {project && (
              <div className="toolbar-actions">
                <button
                  className={workspaceOpen ? 'active text-button' : 'text-button'}
                  data-action="open-workspace"
                  disabled={!cap.canBrowseWorkspace || busy}
                  onClick={() => setWorkspaceOpen((v) => !v)}
                >
                  文件与变更
                </button>
                <button
                  className="text-button"
                  data-action="open-native-history"
                  disabled={busy}
                  onClick={() => navigate('history')}
                >
                  历史
                </button>
              </div>
            )}
          </header>
          {error && (
            <div className="notice error" role="alert">
              {error}
            </div>
          )}
          {!project ? (
            <section className="welcome">
              <span className="assistant-mark">P</span>
              <h2>给你的想法一个工作空间</h2>
              <p>打开本机项目，开始讨论、完成任务，并在这里检查结果。</p>
              <button data-action="welcome-open-project" onClick={() => void choose()}>
                打开项目文件夹
              </button>
              <small>项目文件留在你的电脑上。</small>
            </section>
          ) : (
            <>
              {surface === 'dot' && (
                <MainChatWorkspace key={project.id} project={project} onTask={openConversation} />
              )}
              {surface === 'conversation' && cap.canSubmit && (
                <ConversationPanel
                  key={project.id + ':' + (conversationId ?? 'new:' + newKey)}
                  project={project}
                  conversationId={conversationId}
                  disabled={busy}
                  canCode={cap.canCode}
                  {...(forkSource && !conversationId ? { fork: forkSource } : {})}
                  onCreated={openConversation}
                  onFork={forkConversation}
                />
              )}
              {(surface === 'goals' || surface === 'memory') && (
                <AutonomyDialog
                  key={project.id + ':' + surface}
                  project={project}
                  embedded
                  initialTab={surface === 'memory' ? 'memory' : 'goals'}
                  onClose={() => navigate('conversation')}
                />
              )}
              {(surface === 'tasks' || surface === 'automation') && (
                <div className="page-content">
                  <TaskManager
                    key={project.id + surface}
                    project={project}
                    canCode={cap.canCode}
                    standalone
                    section={surface === 'automation' ? 'schedule' : 'tasks'}
                    onBusyChange={setBusy}
                    onTask={openConversation}
                    onStarted={(runId) => {
                      void value(window.personalAgent.getRun({ projectId: project.id, runId }))
                        .then((run) => {
                          if (projectRef.current !== project.id) return;
                          openConversation(run.taskId);
                        })
                        .catch(() => setError('任务已启动，暂时无法打开；请从侧栏选择它。'));
                    }}
                  />
                </div>
              )}
              {surface === 'workspace' && (
                <WorkspacePanel
                  key={project.id}
                  project={project}
                  canUseTerminal={cap.canUseTerminal}
                  onBusyChange={setBusy}
                  onProjectsChanged={setProjects}
                  onSelected={(p) => {
                    switchProject(p);
                    setSurface('workspace');
                  }}
                />
              )}
              {surface === 'settings' && (
                <div className="page-content settings-page">
                  <div className="page-heading">
                    <div>
                      <h2>工作区设置</h2>
                      <p className="muted">连接、能力和本机数据。</p>
                    </div>
                  </div>
                  <section className="settings-card">
                    <h3>Codex 连接</h3>
                    <p>使用本机支持的登录方式，通过 App Server 执行任务。</p>
                    {children}
                  </section>
                  <section className="settings-card">
                    <h3>项目能力</h3>
                    <p>查看已发现的项目技能与当前可用能力。</p>
                    <button
                      data-action="open-project-skills"
                      disabled={!cap.canBrowseSkills}
                      onClick={() => setSkillsOpen(true)}
                    >
                      查看技能与能力
                    </button>
                  </section>
                  <section className="settings-card">
                    <h3>本机数据</h3>
                    <BackupManager />
                  </section>
                  <section className="settings-card">
                    <h3>运行方式</h3>
                    <p>
                      {cap.backgroundEnabled
                        ? '关闭窗口后本机任务继续；退出应用或电脑休眠时暂停。'
                        : '当前仅前台执行。'}
                    </p>
                  </section>
                </div>
              )}
              {surface === 'history' && (
                <section className="page-content">
                  <div className="page-heading">
                    <div>
                      <h2>原生历史</h2>
                      <p className="muted">查看 Codex 已保存的原始会话；这里不会启动模型。</p>
                    </div>
                    <button
                      data-action="refresh-threads"
                      disabled={busy}
                      onClick={() => void perform(() => readThreads())}
                    >
                      刷新历史
                    </button>
                  </div>
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
                                  window.personalAgent.listTurns({
                                    projectId: project.id,
                                    threadId: t.id,
                                  }),
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
                        {turns?.nextCursor && (
                          <button
                            onClick={() =>
                              void perform(async () => {
                                if (thread)
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
                      {items?.nextCursor && (
                        <button
                          onClick={() =>
                            void perform(async () => {
                              if (thread && turn)
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
              )}
            </>
          )}
          {skillsOpen && project && (
            <ProjectSkillsDialog
              project={project}
              onBusyChange={setBusy}
              onClose={() => setSkillsOpen(false)}
            />
          )}
        </main>
        {workspaceOpen && project && (
          <aside className="workspace-inspector" aria-label="文件与变更面板">
            <header>
              <strong>文件与变更</strong>
              <button
                className="icon-button"
                aria-label="关闭文件面板"
                onClick={() => setWorkspaceOpen(false)}
              >
                ×
              </button>
            </header>
            <WorkspacePanel
              key={project.id}
              project={project}
              canUseTerminal={cap.canUseTerminal}
              onBusyChange={setBusy}
              onProjectsChanged={setProjects}
              onSelected={(p) => {
                switchProject(p);
                setWorkspaceOpen(true);
              }}
            />
          </aside>
        )}
      </div>
    </div>
  );
}
