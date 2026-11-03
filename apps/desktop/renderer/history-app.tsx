import React, { useEffect, useRef, useState } from 'react';
import type { HostResult, ItemView, Page, ProjectView, ThreadSummary, TurnView } from '../../../packages/contracts/src/views.ts';

import { ExecutionPanel } from './execution-panel.tsx';
import {WorkspacePanel} from './workspace-panel.tsx';
import {TaskManager} from './task-manager.tsx';
import {BackupManager} from './backup-manager.tsx';

const labels: Record<string, string> = { completed: '已结束', inProgress: '进行中', failed: '失败', interrupted: '已中断', unknown: '状态未知' };
function errorText(code: string): string {
  if (['PROJECT_IDENTITY_CHANGED', 'PROJECT_UNAVAILABLE'].includes(code)) return '项目目录已变化或不可访问，请重新选择项目。';
  if (['FRAME_TOO_LARGE', 'LEGACY_HISTORY_TOO_LARGE'].includes(code)) return '这份存档超出预览大小限制，请使用 Codex 查看。';
  if (['INVALID_HISTORY_CURSOR', 'THREAD_NOT_IN_PROJECT', 'TURN_NOT_IN_THREAD'].includes(code)) return '列表已变化，请刷新会话后重新选择。';
  if (code === 'HISTORY_SCOPE_MISMATCH') return '记录与当前项目不匹配，已停止加载。请重新选择项目。';
  if (code === 'RUNTIME_BUSY') return '正在处理另一个请求，请稍后再试。';
  return '暂时无法读取记录，请稍后刷新。新建会话可能尚未保存到历史。';
}
async function value<T>(request: Promise<HostResult<T>>): Promise<T> {
  const result = await request;
  if (!result.ok) throw new Error(result.errorCode);
  return result.value;
}
export function HistoryApp({ children }: { children: React.ReactNode }) {
  const [mode, setMode] = useState<'readOnly' | 'workspaceWrite'>('readOnly');
  const [canCode, setCanCode] = useState(false);
  const [canBrowseWorkspace,setCanBrowseWorkspace]=useState(false),[workspaceMode,setWorkspaceMode]=useState(false);
  const [canUseTerminal,setCanUseTerminal]=useState(false);
  const [canSubmit, setCanSubmit] = useState(false);
  const [backgroundEnabled,setBackgroundEnabled]=useState(false);
  const [canManageTasks,setCanManageTasks]=useState(false),[requestedRun,setRequestedRun]=useState<{projectId:string;runId:string}>();
  const [projects, setProjects] = useState<ProjectView[]>([]);
  const [executionMode, setExecutionMode] = useState(true);
  const [project, setProject] = useState<ProjectView>();
  const [threads, setThreads] = useState<Page<ThreadSummary>>();
  const [turns, setTurns] = useState<Page<TurnView>>();
  const [items, setItems] = useState<Page<ItemView>>();
  const [thread, setThread] = useState<ThreadSummary>();
  const [turn, setTurn] = useState<TurnView>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const pending = useRef(false);
  async function perform(task: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(undefined);
    try { await task(); }
    catch (failure) { setError(failure instanceof Error && /^[A-Z0-9_-]{1,100}$/.test(failure.message) ? failure.message : 'HOST_DISCONNECTED'); }
    finally { pending.current = false; setBusy(false); }
  }
  useEffect(() => {
    let stopped = false;
    void value(window.personalAgent.workspaceState()).then(state => {
      if (stopped) return; setCanUseTerminal(state.canUseTerminal);setCanSubmit(state.canSubmit);setBackgroundEnabled(state.backgroundEnabled);setCanManageTasks(state.canManageTasks); setCanCode(state.canCode);setCanBrowseWorkspace(state.canBrowseWorkspace); setMode(state.mode); setProjects(state.projects);
      if (state.projects[0]) { setProject(state.projects[0]); }
    }).catch(() => { if (!stopped) setError('HOST_DISCONNECTED'); });
    return () => { stopped = true; };
  }, []);
  function resetThread() { setThread(undefined); setTurn(undefined); setTurns(undefined); setItems(undefined); }
  const choose = () => perform(async () => {
    const selected = await value(window.personalAgent.chooseProject());
    if (!selected) return;
    setProject(selected); setExecutionMode(true);setWorkspaceMode(false); setProjects(rows => [selected,...rows.filter(p => p.id !== selected.id)]); setThreads(undefined); resetThread();
    setThreads(await value(window.personalAgent.listThreads({ projectId: selected.id })));
  });
  const pageThreads = (cursor?: string) => perform(async () => {
    if (!project) return;
    resetThread(); setThreads(await value(window.personalAgent.listThreads({ projectId: project.id, ...(cursor ? { cursor } : {}) })));
  });
  const openThread = (selected: ThreadSummary) => perform(async () => {
    if (!project) return;
    setExecutionMode(false);setWorkspaceMode(false); resetThread(); setThread(selected);
    setTurns(await value(window.personalAgent.listTurns({ projectId: project.id, threadId: selected.id })));
  });
  const pageTurns = (cursor: string) => perform(async () => {
    if (!project || !thread) return;
    setTurn(undefined); setItems(undefined);
    setTurns(await value(window.personalAgent.listTurns({ projectId: project.id, threadId: thread.id, cursor })));
  });
  const openTurn = (selected: TurnView) => perform(async () => {
    if (!project || !thread) return;
    setTurn(selected); setItems(undefined);
    setItems(await value(window.personalAgent.listItems({ projectId: project.id, threadId: thread.id, turnId: selected.id })));
  });
  const pageItems = (cursor: string) => perform(async () => {
    if (!project || !thread || !turn) return;
    setItems(await value(window.personalAgent.listItems({ projectId: project.id, threadId: thread.id, turnId: turn.id, cursor })));
  });
  return <div className="shell">
    <aside className="sidebar">
      <div className="brand"><span className="brand-mark">P</span><div>Personal Agent<small>你的个人工作区</small></div></div>
      <button data-action="choose-project" className="choose-project" disabled={busy} onClick={() => void choose()}>＋ 选择项目</button>
      {projects.length > 0 && <select className="project-select" aria-label="已保存项目" disabled={busy} value={project?.id ?? ''} onChange={e => { const p = projects.find(p => p.id === e.target.value); if (p) { setProject(p); setExecutionMode(true);setWorkspaceMode(false); resetThread(); setThreads(undefined); } }}>{projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select>}
      {project && canSubmit && <button className="text-button" data-action="project-tasks" disabled={busy} onClick={() => {setExecutionMode(true);setWorkspaceMode(false);}}>项目任务</button>}
      {project&&canBrowseWorkspace&&<button className="text-button" data-action="open-workspace" disabled={busy} onClick={()=>setWorkspaceMode(true)}>工作区 · 文件与 Git</button>}
      <div className="project-heading"><span className="eyebrow">会话</span>{project && <button className="text-button" data-action="refresh-threads" disabled={busy} onClick={() => void pageThreads()}>刷新</button>}</div>
      {project && <div className="project-path" title={project.directory}>{project.name}</div>}
      <nav className="thread-list" aria-label="项目会话">
        {threads?.items.map(entry => <button key={entry.id} data-thread-id={entry.id} className={`thread ${thread?.id === entry.id ? 'selected' : ''}`}
          disabled={busy} onClick={() => void openThread(entry)}><span>{entry.title}</span><small>查看历史记录 ↗</small></button>)}
        {project && threads?.items.length === 0 && <p className="empty-nav">这个项目还没有已保存的会话。</p>}
      </nav>
      {threads?.nextCursor && <button className="text-button" data-action="next-threads" disabled={busy} onClick={() => void pageThreads(threads.nextCursor!)}>下一页会话 →</button>}
      <div className="sidebar-footer"><span className="status-dot"/>本地工作区 · {backgroundEnabled?'关闭窗口继续运行':'前台执行'}</div>
    </aside>
    <main>
      <header className="toolbar"><div><span className="eyebrow">PERSONAL WORKSPACE</span><h1>{project?.name ?? '我的工作区'}</h1></div>{children}</header>
      <div className="connection-status">已有会话保留在本机，选择项目后即可浏览。</div>
      <BackupManager/>
      {error && <div role="alert" className="notice error">{errorText(error)}</div>}
      {workspaceMode&&project?<WorkspacePanel key={project.id} project={project} canUseTerminal={canUseTerminal} onBusyChange={setBusy} onProjectsChanged={setProjects} onSelected={p=>{setProject(p);setThreads(undefined);resetThread();setExecutionMode(true);setWorkspaceMode(true);}}/>:executionMode && project && canSubmit ? <>{canManageTasks&&<TaskManager key={'tasks:'+project.id} project={project} canCode={canCode} onBusyChange={setBusy} onStarted={runId=>setRequestedRun({projectId:project.id,runId})}/>}<ExecutionPanel key={project.id} project={project} disabled={busy} mode={mode} canCode={canCode} requestedRunId={requestedRun?.projectId===project.id?requestedRun.runId:undefined}/></> : !thread ? <section className="welcome"><span className="welcome-mark">⌘</span><h2>{project ? '继续查看你的工作' : '从一个项目开始'}</h2>
        <p>{project ? '从左侧选择一个会话，查看消息、命令和文件变更记录。' : '选择本机的项目目录，打开属于这个项目的会话历史。'}</p>
        <div className="welcome-note">当前为只读浏览，发送新任务暂未开放。</div>
      </section> : <section className="history-panel">
        <div className="history-heading"><h2>{thread.title}</h2><span className="badge">只读历史</span></div>
        <div className="turn-list" aria-label="会话轮次">{turns?.items.map(entry => <button data-turn-id={entry.id} key={entry.id} disabled={busy}
          className={`turn ${turn?.id === entry.id ? 'selected' : ''}`} onClick={() => void openTurn(entry)}>{labels[entry.status]} · {entry.id.slice(-6)}</button>)}
          {turns?.nextCursor && <button className="text-button" disabled={busy} onClick={() => void pageTurns(turns.nextCursor!)}>更早轮次 →</button>}
        </div>
        {turns?.mode === 'legacy' && <p className="history-note">兼容历史记录 · 大型存档可能需要更新后再查看。</p>}
        {turns?.items.length === 0 && <div className="empty-history">此会话尚无已保存的轮次。</div>}
        {!turn && turns && turns.items.length > 0 && <div className="empty-history">选择一个轮次查看消息与工具记录。</div>}
        <div className="items" data-history-items>{items?.items.map(item => <article className={`item ${item.role}`} key={item.id} data-item-id={item.id} data-item-kind={item.kind}>
          <div className="item-meta"><strong>{item.label}</strong><span>{item.status === 'complete' ? '记录已结束' : item.status === 'streaming' ? '未结束' : '状态未知'}</span></div>
          <pre>{item.text || '此记录没有可显示的文本。'}</pre>
          {item.truncated && <small className="clip-note">文本过长，当前仅显示部分内容。</small>}
        </article>)}</div>
        {items?.items.length === 0 && <div className="empty-history">此轮次没有可显示的记录。</div>}
        {items?.nextCursor && <button className="secondary next-items" disabled={busy} onClick={() => void pageItems(items.nextCursor!)}>下一页记录 →</button>}
      </section>}
      {!workspaceMode&&!(executionMode && project && canSubmit) && <footer className="composer"><textarea aria-label="任务输入" disabled placeholder="暂时无法发送新任务，仍可查看已有记录。" rows={2}/><button data-action="send" disabled>发送 ↑</button></footer>}
    </main>
  </div>;
}
