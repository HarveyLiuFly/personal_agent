import React, { useEffect, useRef, useState } from 'react';
import type { HostResult, ProjectView } from '../../../packages/contracts/src/views.ts';
import { MainChatWorkspace } from './main-chat.tsx';
import { AutonomyDialog } from './autonomy-manager.tsx';
import { ConversationPanel } from './conversation-panel.tsx';
import { WorkspacePanel } from './workspace-panel.tsx';
import { TaskManager } from './task-manager.tsx';
import { PanelBoundary } from './panel-boundary.tsx';
import { SettingsPage } from './settings-page.tsx';
import { Sidebar } from './sidebar.tsx';
import type { SidebarPage } from './sidebar.tsx';

const titles: Record<Exclude<SidebarPage, 'conversation'>, string> = {
  dot: 'Dot',
  goals: '目标',
  schedules: '定时',
  settings: '设置',
};
async function value<T>(request: Promise<HostResult<T>>) {
  const result = await request;
  if (!result.ok) throw Error(result.errorCode);
  return result.value;
}

/**
 * The window: projects and conversations on the left, the open conversation (or page) in the
 * middle, files and changes on the right. Each column fails on its own.
 */
export function AppShell({ connection }: { connection: React.ReactNode }) {
  const [projects, setProjects] = useState<ProjectView[]>([]),
    [project, setProject] = useState<ProjectView>(),
    [page, setPage] = useState<SidebarPage>('conversation');
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
  const [conversationId, setConversationId] = useState<string>(),
    [title, setTitle] = useState(''),
    [forkSource, setForkSource] = useState<{ runId: string; title: string }>(),
    [newKey, setNewKey] = useState(0);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [collapsed, setCollapsed] = useState(false),
    [rightOpen, setRightOpen] = useState(false);
  const lock = useRef(false),
    projectRef = useRef(project?.id),
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
        if (stopped) return;
        setCap({ ...state, canBrowseSkills: state.canBrowseSkills === true });
        setProjects(state.projects);
        setProject(state.projects.find((p) => !p.sourceId) ?? state.projects[0]);
      })
      .catch(() => setError('暂时无法连接本机服务。'));
    return () => {
      stopped = true;
    };
  }, []);
  // A conversation to open once the project switch below has reset the view.
  const openAfterSwitch = useRef<string | undefined>(undefined);
  useEffect(() => {
    setConversationId(openAfterSwitch.current);
    openAfterSwitch.current = undefined;
    setForkSource(undefined);
    setTitle('');
  }, [project?.id]);
  function switchProject(next: ProjectView, conversation?: string) {
    if (next.id === project?.id) {
      setConversationId(conversation);
      return;
    }
    openAfterSwitch.current = conversation;
    setProject(next);
  }
  function newConversation(projectId = project?.id) {
    const target = projects.find((p) => p.id === projectId);
    if (busy || !target) return;
    switchProject(target);
    setForkSource(undefined);
    setNewKey((k) => k + 1);
    setTitle('');
    setPage('conversation');
  }
  function openConversation(projectId: string, id: string) {
    const target = projects.find((p) => p.id === projectId);
    if (!target) return;
    switchProject(target, id);
    setForkSource(undefined);
    setPage('conversation');
  }
  function forkConversation(source: { runId: string; title: string }) {
    if (busy) return;
    setConversationId(undefined);
    setForkSource(source);
    setNewKey((k) => k + 1);
    setTitle('');
    setPage('conversation');
  }
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      if (e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setCollapsed(false);
        requestAnimationFrame(() => search.current?.focus());
      } else if (e.key.toLowerCase() === 'n' && !busy && project) {
        e.preventDefault();
        newConversation();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [project?.id, busy, projects]);
  const choose = () =>
    perform(async () => {
      const selected = await value(window.personalAgent.chooseProject());
      if (selected) {
        setProjects((old) => [selected, ...old.filter((p) => p.id !== selected.id)]);
        switchProject(selected);
        setPage('conversation');
      }
    });
  const heading =
    page !== 'conversation'
      ? titles[page]
      : conversationId
        ? title || '对话'
        : forkSource
          ? '从这里新开'
          : '新对话';
  return (
    <div
      className={
        'shell three-column' +
        (collapsed ? ' sidebar-collapsed' : '') +
        (rightOpen && project ? ' right-open' : '')
      }
    >
      <PanelBoundary name="侧栏">
        <Sidebar
          projects={projects}
          {...(project ? { project } : {})}
          page={page}
          {...(conversationId ? { conversationId } : {})}
          busy={busy}
          canSubmit={cap.canSubmit}
          onOpen={openConversation}
          onNew={newConversation}
          onChooseProject={() => void choose()}
          onNavigate={(next) => {
            setPage(next);
            setError('');
          }}
          onCollapse={() => setCollapsed(true)}
          searchRef={search}
          footer={
            <>
              {connection}
              <span className="muted">
                {cap.backgroundEnabled ? '本机运行 · 关窗继续' : '本机工作区'}
              </span>
            </>
          }
        />
      </PanelBoundary>
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
            {project && page !== 'settings' && (
              <>
                <span className="project-crumb">{project.name}</span>
                <span className="crumb-separator">/</span>
              </>
            )}
            <h1>{heading}</h1>
          </div>
          {project && (
            <div className="toolbar-actions">
              <button
                className={rightOpen ? 'active text-button' : 'text-button'}
                data-action="open-workspace"
                aria-pressed={rightOpen}
                disabled={!cap.canBrowseWorkspace}
                onClick={() => setRightOpen((v) => !v)}
              >
                文件与变更
              </button>
            </div>
          )}
        </header>
        {error && (
          <div className="notice error" role="alert">
            {error}
          </div>
        )}
        <PanelBoundary name={page === 'conversation' ? '对话' : titles[page]}>
          {page === 'settings' ? (
            <SettingsPage
              {...(project ? { project } : {})}
              canCode={cap.canCode}
              canBrowseSkills={cap.canBrowseSkills}
              backgroundEnabled={cap.backgroundEnabled}
              connection={connection}
              onBusyChange={setBusy}
              onOpenConversation={(id) => project && openConversation(project.id, id)}
              onStarted={(runId) => {
                if (!project) return;
                void value(window.personalAgent.getRun({ projectId: project.id, runId }))
                  .then((run) => {
                    if (projectRef.current === project.id) openConversation(project.id, run.taskId);
                  })
                  .catch(() => setError('任务已启动，暂时无法打开；请从侧栏选择它。'));
              }}
            />
          ) : !project ? (
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
              {page === 'dot' && (
                <MainChatWorkspace
                  key={project.id}
                  project={project}
                  onTask={(id) => openConversation(project.id, id)}
                />
              )}
              {page === 'conversation' && cap.canSubmit && (
                <ConversationPanel
                  key={project.id + ':' + (conversationId ?? 'new:' + newKey)}
                  project={project}
                  conversationId={conversationId}
                  disabled={busy}
                  canCode={cap.canCode}
                  {...(forkSource && !conversationId ? { fork: forkSource } : {})}
                  onTitle={setTitle}
                  onCreated={(id) => openConversation(project.id, id)}
                  onCreatedIn={(workspace, id) => {
                    setProjects((old) => [...old.filter((p) => p.id !== workspace.id), workspace]);
                    openAfterSwitch.current = id;
                    setProject(workspace);
                  }}
                  onFork={forkConversation}
                />
              )}
              {page === 'goals' && (
                <AutonomyDialog
                  key={project.id + ':goals'}
                  project={project}
                  embedded
                  initialTab="goals"
                  onClose={() => setPage('conversation')}
                />
              )}
              {page === 'schedules' && (
                <div className="page-content">
                  <TaskManager
                    key={project.id + ':schedule'}
                    project={project}
                    canCode={cap.canCode}
                    standalone
                    section="schedule"
                    onBusyChange={setBusy}
                    onTask={(id) => openConversation(project.id, id)}
                    onStarted={(runId) => {
                      void value(window.personalAgent.getRun({ projectId: project.id, runId }))
                        .then((run) => {
                          if (projectRef.current === project.id)
                            openConversation(project.id, run.taskId);
                        })
                        .catch(() => setError('任务已启动，暂时无法打开；请从侧栏选择它。'));
                    }}
                  />
                </div>
              )}
            </>
          )}
        </PanelBoundary>
      </main>
      {rightOpen && project && (
        <aside className="workspace-inspector" aria-label="文件与变更面板">
          <header>
            <strong>文件与变更</strong>
            <button
              className="icon-button"
              aria-label="关闭文件面板"
              onClick={() => setRightOpen(false)}
            >
              ×
            </button>
          </header>
          <PanelBoundary name="文件与变更面板">
            <WorkspacePanel
              key={project.id}
              project={project}
              canUseTerminal={cap.canUseTerminal}
              onBusyChange={setBusy}
              onProjectsChanged={setProjects}
              onSelected={(p) => switchProject(p)}
            />
          </PanelBoundary>
        </aside>
      )}
    </div>
  );
}
