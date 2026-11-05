import React, { useEffect, useRef, useState } from 'react';
import type { HostResult, ProjectView } from '../../../packages/contracts/src/views.ts';
import type {
  ConversationGroup,
  ConversationSummary,
} from '../../../packages/contracts/src/conversations.ts';
import { conversationMarker, projectTree, relativeTime } from './ui-model.ts';
import { clearDrafts } from './drafts.ts';
import { shortcutLabel } from './platform.ts';
import { subscribeRefresh } from './host-events.ts';

async function value<T>(request: Promise<HostResult<T>>) {
  const result = await request;
  if (!result.ok) throw Error(result.errorCode);
  return result.value;
}
/** Rows shown per project before “显示更多”. */
const FOLD = 5;

export type SidebarPage = 'conversation' | 'dot' | 'goals' | 'schedules' | 'settings';
interface Props {
  projects: ProjectView[];
  project?: ProjectView;
  page: SidebarPage;
  conversationId?: string;
  busy: boolean;
  canSubmit: boolean;
  onOpen: (projectId: string, conversationId: string) => void;
  onNew: (projectId: string) => void;
  onChooseProject: () => void;
  onNavigate: (page: Exclude<SidebarPage, 'conversation'>) => void;
  onCollapse: () => void;
  /** Ctrl/Cmd+K focuses this. */
  searchRef: React.RefObject<HTMLInputElement | null>;
  /** The connection status line. */
  footer: React.ReactNode;
}

/**
 * Left column: the Dot, a new conversation, search, and every project with its conversations
 * (worktrees under the project they came from), then goals, schedules and settings.
 */
export function Sidebar(props: Props) {
  const { projects, project, page, conversationId, busy } = props;
  const [query, setQuery] = useState(''),
    [archived, setArchived] = useState(false),
    [groups, setGroups] = useState<Record<string, ConversationGroup>>({}),
    // Extra pages read per project (“显示更多”), and their rows.
    [extra, setExtra] = useState<Record<string, number>>({}),
    [more, setMore] = useState<
      Record<string, { rows: ConversationSummary[]; next: string | null }>
    >({}),
    [open, setOpen] = useState<Record<string, boolean>>({}),
    [loaded, setLoaded] = useState(false),
    [, setClock] = useState(0);
  const privacy = useRef<number | undefined>(undefined);
  useEffect(() => {
    let stopped = false;
    const text = query.trim();
    async function refresh() {
      try {
        const scope = { ...(text ? { query: text } : {}), ...(archived ? { archived: true } : {}) };
        const read = await value(window.personalAgent.listConversationGroups(scope));
        const pages: typeof more = {};
        for (const group of read) {
          let cursor = group.nextCursor;
          const rows: ConversationSummary[] = [];
          for (let n = 0; n < (extra[group.projectId] ?? 0) && cursor; n++) {
            const next = await value(
              window.personalAgent.listConversations({
                projectId: group.projectId,
                ...scope,
                cursor,
              }),
            );
            rows.push(...next.items);
            cursor = next.nextCursor;
          }
          pages[group.projectId] = { rows, next: cursor };
        }
        const epochs = await value(window.personalAgent.memoryState());
        if (stopped) return;
        setGroups(Object.fromEntries(read.map((group) => [group.projectId, group])));
        setMore(pages);
        setLoaded(true);
        // Forgetting memory also drops unsent drafts that may quote it.
        if (privacy.current !== undefined && privacy.current !== epochs.privacyEpoch) clearDrafts();
        privacy.current = epochs.privacyEpoch;
      } catch {
        /* keep the last list */
      }
    }
    // Re-read after each Host change notice instead of polling.
    const unsubscribe = subscribeRefresh(refresh);
    return () => {
      stopped = true;
      unsubscribe();
    };
  }, [query, archived, extra, projects.length]);
  // Relative times refresh when the window comes back into view (no timers).
  useEffect(() => {
    const tick = () => setClock((n) => n + 1);
    window.addEventListener('focus', tick);
    document.addEventListener('visibilitychange', tick);
    return () => {
      window.removeEventListener('focus', tick);
      document.removeEventListener('visibilitychange', tick);
    };
  }, []);
  const now = Date.now(),
    searching = Boolean(query.trim());
  function rows(projectId: string): { list: ConversationSummary[]; hidden: number; next: boolean } {
    const group = groups[projectId];
    if (!group) return { list: [], hidden: 0, next: false };
    const all = [...group.pinned, ...group.items, ...(more[projectId]?.rows ?? [])];
    const showAll = searching || (extra[projectId] ?? 0) > 0 || open[`all:${projectId}`] === true;
    const list = showAll ? all : all.slice(0, group.pinned.length + FOLD);
    return {
      list,
      hidden: all.length - list.length,
      next: Boolean(more[projectId] ? more[projectId]!.next : group.nextCursor) && showAll,
    };
  }
  function row(conversation: ConversationSummary) {
    const marker = conversationMarker(conversation),
      selected = page === 'conversation' && conversationId === conversation.conversationId;
    const flag = ['waiting_approval', 'waiting_input', 'outcome_unknown', 'running'].includes(
      marker.dot,
    );
    return (
      <button
        key={conversation.conversationId}
        className={
          'thread' + (selected ? ' selected' : '') + (conversation.unread ? ' unread' : '')
        }
        aria-current={selected ? 'page' : undefined}
        data-task-id={conversation.conversationId}
        data-conversation-id={conversation.conversationId}
        data-run-id={conversation.latestRunId ?? undefined}
        title={conversation.title}
        onClick={() => props.onOpen(conversation.projectId, conversation.conversationId)}
      >
        {conversation.unread && !flag && <span className="unread-dot" aria-label="未读" />}
        <span className="thread-name">
          {conversation.pinned && (
            <span className="pin-mark" aria-label="已置顶">
              ★{' '}
            </span>
          )}
          {conversation.title}
        </span>
        {flag ? (
          <span className={'thread-flag ' + marker.dot}>
            {marker.dot === 'running' && <span className="spinner" aria-hidden="true" />}
            {marker.label}
          </span>
        ) : (
          <small className="thread-time">{relativeTime(conversation.updatedAt, now)}</small>
        )}
      </button>
    );
  }
  function group(item: ProjectView, worktree = false) {
    const { list, hidden, next } = rows(item.id),
      collapsed = open[item.id] === false,
      current = project?.id === item.id;
    if (searching && !list.length) return null;
    return (
      <div
        key={item.id}
        className={'project-group' + (worktree ? ' worktree' : '') + (current ? ' current' : '')}
        data-project-group={item.id}
      >
        <div className="project-row">
          <button
            className="project-toggle"
            aria-expanded={!collapsed}
            title={item.directory}
            onClick={() => setOpen((o) => ({ ...o, [item.id]: collapsed }))}
          >
            <span className="chevron" aria-hidden="true">
              {collapsed ? '›' : '⌄'}
            </span>
            {worktree && (
              <span className="worktree-mark" aria-label="工作树">
                ⎇
              </span>
            )}
            <span className="project-name">{item.name}</span>
          </button>
          <button
            className="icon-button project-new"
            data-action="new-in-project"
            aria-label={`在 ${item.name} 中新对话`}
            title="新对话"
            disabled={busy || !props.canSubmit}
            onClick={() => props.onNew(item.id)}
          >
            ＋
          </button>
        </div>
        {!collapsed && (
          <div className="project-threads">
            {list.map(row)}
            {loaded && !list.length && (
              <p className="empty-nav">{archived ? '没有已归档的对话' : '还没有对话'}</p>
            )}
            {hidden > 0 && (
              <button
                className="text-button more-conversations"
                data-action="show-more-conversations"
                onClick={() => setOpen((o) => ({ ...o, [`all:${item.id}`]: true }))}
              >
                显示更多（{hidden}）
              </button>
            )}
            {next && (
              <button
                className="text-button more-conversations"
                data-action="more-conversations"
                onClick={() => setExtra((e) => ({ ...e, [item.id]: (e[item.id] ?? 0) + 1 }))}
              >
                更早的对话
              </button>
            )}
          </div>
        )}
      </div>
    );
  }
  const tree = projectTree(projects);
  return (
    <aside className="sidebar" aria-label="主导航">
      <div className="brand">
        <span className="brand-mark">P</span>
        <strong>Personal Agent</strong>
        <button className="icon-button" aria-label="收起侧栏" onClick={props.onCollapse}>
          ‹
        </button>
      </div>
      <button
        className={'dot-entry' + (page === 'dot' ? ' active' : '')}
        data-action="open-main-chat"
        aria-current={page === 'dot' ? 'page' : undefined}
        disabled={!project || busy}
        title="Dot：你的个人助手，可以帮你安排项目里的对话和待办"
        onClick={() => props.onNavigate('dot')}
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
        disabled={!project || busy || !props.canSubmit}
        title={project ? `在 ${project.name} 中新对话` : '先打开一个项目'}
        onClick={() => project && props.onNew(project.id)}
      >
        ＋ 新对话 <kbd>{shortcutLabel('n')}</kbd>
      </button>
      <div className="sidebar-search">
        <input
          ref={props.searchRef}
          aria-label="搜索对话"
          placeholder={archived ? '搜索已归档的对话…' : '搜索对话…'}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setQuery('');
          }}
        />
        <kbd>{shortcutLabel('k')}</kbd>
      </div>
      <div className="project-heading">
        <span>{archived ? '已归档' : '项目'}</span>
        <span>
          <button
            className="text-button"
            data-action="toggle-archived"
            aria-pressed={archived}
            onClick={() => setArchived((v) => !v)}
          >
            {archived ? '返回' : '已归档'}
          </button>
          <button
            className="icon-button"
            data-action="choose-project"
            aria-label="打开项目"
            title="打开项目文件夹"
            disabled={busy}
            onClick={props.onChooseProject}
          >
            ＋
          </button>
        </span>
      </div>
      <nav className="thread-list" aria-label="对话">
        {tree.map(({ project: item, worktrees }) => (
          <React.Fragment key={item.id}>
            {group(item)}
            {worktrees.map((w) => group(w, true))}
          </React.Fragment>
        ))}
        {!projects.length && <p className="empty-nav">打开一个项目文件夹开始。</p>}
        {searching && loaded && !tree.some(({ project: p }) => rows(p.id).list.length) && (
          <p className="empty-nav">没有匹配的对话</p>
        )}
      </nav>
      <nav className="secondary-nav" aria-label="更多">
        <button
          data-action="open-goals"
          className={page === 'goals' ? 'active' : ''}
          aria-current={page === 'goals' ? 'page' : undefined}
          disabled={!project}
          onClick={() => props.onNavigate('goals')}
        >
          <span aria-hidden="true">◇</span> 目标
        </button>
        <button
          data-action="open-automation"
          className={page === 'schedules' ? 'active' : ''}
          aria-current={page === 'schedules' ? 'page' : undefined}
          disabled={!project}
          onClick={() => props.onNavigate('schedules')}
        >
          <span aria-hidden="true">⏱</span> 定时
        </button>
        <button
          data-action="open-settings"
          className={page === 'settings' ? 'active' : ''}
          aria-current={page === 'settings' ? 'page' : undefined}
          onClick={() => props.onNavigate('settings')}
        >
          <span aria-hidden="true">⚙</span> 设置
        </button>
      </nav>
      <div className="sidebar-footer">{props.footer}</div>
    </aside>
  );
}
