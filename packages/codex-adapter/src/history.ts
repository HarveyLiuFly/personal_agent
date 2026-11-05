import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import type {
  ItemView,
  Page,
  ProjectView,
  ThreadSummary,
  TurnView,
} from '../../contracts/src/views.ts';
import { itemView } from './projection.ts';
import { isObject, RpcFailure } from './rpc.ts';
import type { ThreadListParams } from './generated/v2/ThreadListParams.ts';
import type { ThreadReadParams } from './generated/v2/ThreadReadParams.ts';
import type { ThreadTurnsListParams } from './generated/v2/ThreadTurnsListParams.ts';
import type { ThreadItemsListParams } from './generated/v2/ThreadItemsListParams.ts';

export interface ReadPort {
  request<T = unknown>(method: string, params: unknown): Promise<T>;
}
export type WithReadPort = <T>(read: (port: ReadPort) => Promise<T>) => Promise<T>;
interface Project {
  view: ProjectView;
  dev: number;
  ino: number;
  threads: Map<string, Map<string, TurnView>>;
}
interface Cursor {
  kind: 'threads' | 'turns' | 'items';
  projectId: string;
  threadId?: string;
  turnId?: string;
  offset: number;
  native: string | null;
  mode: 'paginated' | 'legacy';
}
const pageSize = 20;
const id = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 200 &&
  !/[\x00-\x1f]/.test(value);
const fail = (code: string): never => {
  throw new RpcFailure(code);
};
function query(input: unknown, required: string[]): Record<string, string> {
  if (!isObject(input) || Object.keys(input).some((key) => ![...required, 'cursor'].includes(key)))
    return fail('INVALID_HISTORY_QUERY');
  for (const key of required) if (!id(input[key])) return fail('INVALID_HISTORY_QUERY');
  if (input.cursor !== undefined && !id(input.cursor)) return fail('INVALID_HISTORY_QUERY');
  return input as Record<string, string>;
}
function rows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.some((row) => !isObject(row)))
    return fail('INVALID_HISTORY_RESPONSE');
  return value as Record<string, unknown>[];
}
function status(value: unknown): TurnView['status'] {
  return value === 'completed' ||
    value === 'inProgress' ||
    value === 'failed' ||
    value === 'interrupted'
    ? value
    : 'unknown';
}
function pageResponse(value: unknown): {
  data: Record<string, unknown>[];
  nextCursor: string | null;
} {
  if (
    !isObject(value) ||
    (value.nextCursor !== null &&
      (typeof value.nextCursor !== 'string' || value.nextCursor.length > 4096))
  )
    return fail('INVALID_HISTORY_RESPONSE');
  const data = rows(value.data);
  if (data.length > pageSize) return fail('HISTORY_PAGE_TOO_LARGE');
  return { data, nextCursor: value.nextCursor as string | null };
}

/** Read-only navigation authority. Folder registration is Host-only, never a Renderer-supplied path. */
export class HistoryBrowser {
  private projects = new Map<string, Project>();
  private cursors = new Map<string, Cursor>();
  private withPort: WithReadPort;
  private register?: (directory: string) => ProjectView;
  constructor(withPort: WithReadPort, register?: (directory: string) => ProjectView) {
    this.withPort = withPort;
    this.register = register;
  }
  async registerDirectory(directory: string): Promise<ProjectView> {
    const canonical = await realpath(directory);
    const info = await stat(canonical);
    if (!info.isDirectory()) return fail('PROJECT_NOT_DIRECTORY');
    const existing = [...this.projects.values()].find(
      (project) =>
        project.view.directory === canonical &&
        project.dev === info.dev &&
        project.ino === info.ino,
    );
    if (existing) return { ...existing.view };
    if (this.projects.size >= 16) return fail('PROJECT_LIMIT');
    const view = this.register?.(canonical) ?? {
      id: randomUUID(),
      name: basename(canonical) || canonical,
      directory: canonical,
    };
    this.projects.set(view.id, { view, dev: info.dev, ino: info.ino, threads: new Map() });
    return { ...view };
  }
  private async project(projectId: string): Promise<Project> {
    const project = this.projects.get(projectId);
    if (!project) return fail('UNKNOWN_PROJECT');
    const canonical = await realpath(project.view.directory).catch(() =>
      fail('PROJECT_UNAVAILABLE'),
    );
    const info = await stat(canonical).catch(() => fail('PROJECT_UNAVAILABLE'));
    if (
      !info.isDirectory() ||
      canonical !== project.view.directory ||
      info.dev !== project.dev ||
      info.ino !== project.ino
    )
      return fail('PROJECT_IDENTITY_CHANGED');
    return project;
  }
  private cursor(
    token: string | undefined,
    scope: Omit<Cursor, 'offset' | 'native' | 'mode'>,
  ): Cursor | undefined {
    if (!token) return;
    const cursor = this.cursors.get(token);
    if (
      !cursor ||
      cursor.kind !== scope.kind ||
      cursor.projectId !== scope.projectId ||
      cursor.threadId !== scope.threadId ||
      cursor.turnId !== scope.turnId
    )
      return fail('INVALID_HISTORY_CURSOR');
    return cursor;
  }
  private next(cursor: Cursor, hasNext: boolean): string | null {
    if (!hasNext) return null;
    if (this.cursors.size >= 64) this.cursors.delete(this.cursors.keys().next().value!);
    const token = randomUUID();
    this.cursors.set(token, cursor);
    return token;
  }
  private clearCursors(projectId: string): void {
    for (const [token, cursor] of this.cursors)
      if (cursor.projectId === projectId) this.cursors.delete(token);
  }
  private scopedThread(project: Project, threadId: string): Map<string, TurnView> {
    const turns = project.threads.get(threadId);
    if (!turns) return fail('THREAD_NOT_IN_PROJECT');
    return turns;
  }
  private checkThread(
    value: unknown,
    project: Project,
    threadId?: string,
  ): Record<string, unknown> {
    if (!isObject(value) || !id(value.id)) return fail('INVALID_HISTORY_RESPONSE');
    if (value.cwd !== project.view.directory || (threadId && value.id !== threadId))
      return fail('HISTORY_SCOPE_MISMATCH');
    return value;
  }
  private async metadata(
    port: ReadPort,
    project: Project,
    threadId: string,
  ): Promise<Record<string, unknown>> {
    const response = await port.request('thread/read', {
      threadId,
      includeTurns: false,
    } satisfies ThreadReadParams);
    if (!isObject(response)) return fail('INVALID_HISTORY_RESPONSE');
    const thread = this.checkThread(response.thread, project, threadId);
    if (thread.historyMode !== 'paginated' && thread.historyMode !== 'legacy')
      return fail('HISTORY_MODE_UNSUPPORTED');
    return thread;
  }
  private async legacy(
    port: ReadPort,
    project: Project,
    threadId: string,
  ): Promise<Record<string, unknown>[]> {
    const response = await port.request('thread/read', {
      threadId,
      includeTurns: true,
    } satisfies ThreadReadParams);
    if (!isObject(response)) return fail('INVALID_HISTORY_RESPONSE');
    const thread = this.checkThread(response.thread, project, threadId);
    if (thread.historyMode !== 'legacy') return fail('HISTORY_MODE_CHANGED');
    const turns = rows(thread.turns);
    // The transport additionally bounds the full JSON frame at 1 MiB. Large legacy histories fail closed.
    if (turns.length > 500) return fail('LEGACY_HISTORY_TOO_LARGE');
    return turns;
  }
  async listThreads(input: unknown): Promise<Page<ThreadSummary>> {
    const q = query(input, ['projectId']);
    const projectId = q.projectId!;
    const project = await this.project(projectId);
    const scope = { kind: 'threads' as const, projectId };
    const cursor = this.cursor(q.cursor, scope);
    if (!cursor) {
      project.threads.clear();
      this.clearCursors(projectId);
    }
    return this.withPort(async (port) => {
      const response = pageResponse(
        await port.request('thread/list', {
          cwd: project.view.directory,
          cursor: cursor?.native,
          limit: pageSize,
          modelProviders: [],
          sourceKinds: ['cli', 'vscode', 'exec', 'appServer'],
          sortKey: 'updated_at',
          sortDirection: 'desc',
        } satisfies ThreadListParams),
      );
      // Validate every row before exporting any title or authorizing a thread ID.
      const threads = response.data.map((thread) => this.checkThread(thread, project));
      if (
        project.threads.size +
          threads.filter((thread) => !project.threads.has(String(thread.id))).length >
        500
      )
        return fail('HISTORY_NAVIGATION_LIMIT');
      const items = threads.map((thread) => {
        const threadId = String(thread.id);
        if (!project.threads.has(threadId)) project.threads.set(threadId, new Map());
        return {
          id: threadId,
          title: (
            (typeof thread.name === 'string' && thread.name) ||
            (typeof thread.preview === 'string' && thread.preview) ||
            '未命名会话'
          ).slice(0, 160),
          updatedAt:
            typeof thread.updatedAt === 'number' && Number.isFinite(thread.updatedAt)
              ? thread.updatedAt
              : 0,
          status:
            isObject(thread.status) &&
            ['idle', 'active', 'notLoaded', 'systemError'].includes(String(thread.status.type))
              ? String(thread.status.type)
              : 'unknown',
        };
      });
      return {
        items,
        nextCursor: this.next(
          { ...scope, native: response.nextCursor, offset: 0, mode: 'paginated' },
          response.nextCursor !== null,
        ),
        mode: 'paginated',
        truncated: false,
      };
    });
  }
  async listTurns(input: unknown): Promise<Page<TurnView>> {
    const q = query(input, ['projectId', 'threadId']);
    const projectId = q.projectId!,
      threadId = q.threadId!;
    const project = await this.project(projectId);
    const known = this.scopedThread(project, threadId);
    const scope = { kind: 'turns' as const, projectId, threadId };
    const cursor = this.cursor(q.cursor, scope);
    return this.withPort(async (port) => {
      const thread = await this.metadata(port, project, threadId);
      const mode = thread.historyMode as 'paginated' | 'legacy';
      if (cursor && cursor.mode !== mode) return fail('HISTORY_MODE_CHANGED');
      let data: Record<string, unknown>[], next: string | null, hasNext: boolean;
      const offset = cursor?.offset ?? 0;
      if (mode === 'paginated') {
        const response = pageResponse(
          await port.request('thread/turns/list', {
            threadId,
            cursor: cursor?.native,
            limit: pageSize,
            itemsView: 'summary',
            sortDirection: 'desc',
          } satisfies ThreadTurnsListParams),
        );
        data = response.data;
        next = response.nextCursor;
        hasNext = next !== null;
      } else {
        const all = (await this.legacy(port, project, threadId)).slice().reverse();
        data = all.slice(offset, offset + pageSize);
        next = null;
        hasNext = offset + pageSize < all.length;
      }
      const items = data.map((turn) => {
        if (!id(turn.id)) return fail('INVALID_HISTORY_RESPONSE');
        return { id: turn.id, status: status(turn.status) };
      });
      if (!cursor) known.clear();
      if (known.size + items.filter((turn) => !known.has(turn.id)).length > 500)
        return fail('HISTORY_NAVIGATION_LIMIT');
      for (const turn of items) known.set(turn.id, turn);
      return {
        items,
        nextCursor: this.next({ ...scope, native: next, offset: offset + pageSize, mode }, hasNext),
        mode,
        truncated: false,
      };
    });
  }
  async listItems(input: unknown): Promise<Page<ItemView>> {
    const q = query(input, ['projectId', 'threadId', 'turnId']);
    const projectId = q.projectId!,
      threadId = q.threadId!,
      turnId = q.turnId!;
    const project = await this.project(projectId);
    const known = this.scopedThread(project, threadId);
    const turn = known.get(turnId);
    if (!turn) return fail('TURN_NOT_IN_THREAD');
    const scope = { kind: 'items' as const, projectId, threadId, turnId };
    const cursor = this.cursor(q.cursor, scope);
    return this.withPort(async (port) => {
      const thread = await this.metadata(port, project, threadId);
      const mode = thread.historyMode as 'paginated' | 'legacy';
      if (cursor && cursor.mode !== mode) return fail('HISTORY_MODE_CHANGED');
      const offset = cursor?.offset ?? 0;
      let data: Record<string, unknown>[], next: string | null, hasNext: boolean;
      if (mode === 'paginated') {
        const response = pageResponse(
          await port.request('thread/items/list', {
            threadId,
            turnId,
            cursor: cursor?.native,
            limit: pageSize,
            sortDirection: 'asc',
          } satisfies ThreadItemsListParams),
        );
        data = response.data.map((entry) => {
          if (entry.turnId !== turnId || !isObject(entry.item))
            return fail('HISTORY_SCOPE_MISMATCH');
          return entry.item;
        });
        next = response.nextCursor;
        hasNext = next !== null;
      } else {
        const all = await this.legacy(port, project, threadId);
        const selected = all.find((item) => item.id === turnId);
        if (!selected) return fail('TURN_NOT_IN_THREAD');
        const allItems = rows(selected.items);
        if (allItems.length > 5000) return fail('LEGACY_HISTORY_TOO_LARGE');
        data = allItems.slice(offset, offset + pageSize);
        next = null;
        hasNext = offset + pageSize < allItems.length;
      }
      let budget = 65_536;
      const items = data.map((item) => {
        const view = itemView(
          turnId,
          item,
          turn.status !== 'inProgress' && turn.status !== 'unknown',
          Math.min(16_384, budget),
        );
        if (!view) return fail('INVALID_HISTORY_RESPONSE');
        budget -= view.text.length;
        return view;
      });
      return {
        items,
        nextCursor: this.next({ ...scope, native: next, offset: offset + pageSize, mode }, hasNext),
        mode,
        truncated: items.some((item) => item.truncated),
      };
    });
  }
}
