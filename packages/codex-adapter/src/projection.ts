import type { ItemView, ThreadView, TurnView } from '../../contracts/src/views.ts';

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const identity = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 200;
export interface ProjectionLimits {
  items: number;
  turns: number;
  itemText: number;
  totalText: number;
}
const defaults: ProjectionLimits = { items: 200, turns: 50, itemText: 16_384, totalText: 262_144 };
function cut(text: string, maximum: number): string {
  const value = text.slice(0, Math.max(0, maximum));
  // Avoid splitting a UTF-16 surrogate pair at the display budget boundary.
  return /[\uD800-\uDBFF]$/.test(value) ? value.slice(0, -1) : value;
}
function turnStatus(value: unknown): TurnView['status'] {
  return value === 'inProgress' ||
    value === 'completed' ||
    value === 'failed' ||
    value === 'interrupted'
    ? value
    : 'unknown';
}

function toolResult(result: ItemView, item: Record<string, unknown>, statuses: string[]): void {
  result.toolStatus =
    typeof item.status === 'string' && statuses.includes(item.status)
      ? (item.status as ItemView['toolStatus'])
      : 'unknown';
  if (Number.isSafeInteger(item.durationMs) && Number(item.durationMs) >= 0)
    result.durationMs = Number(item.durationMs);
}
/** Convert trusted-transport data to bounded plain text; never carry tool arguments, HTML, or local image URLs. */
export function itemView(
  turnId: string,
  item: Record<string, unknown>,
  complete: boolean,
  maximum = defaults.itemText,
): ItemView | undefined {
  if (!identity(item.id) || !identity(turnId)) return;
  const result: ItemView = {
    id: item.id,
    turnId,
    kind: 'unknown',
    role: 'system',
    label: '尚不支持的记录',
    text: '',
    status: complete ? 'complete' : 'streaming',
    truncated: false,
  };
  let text = '';
  const string = (value: unknown) => (typeof value === 'string' ? value : '');
  switch (item.type) {
    case 'userMessage':
      result.kind = 'message';
      result.role = 'user';
      result.label = '你';
      text = Array.isArray(item.content)
        ? item.content
            .map((input) =>
              object(input) && input.type === 'text' ? string(input.text) : '[附件]',
            )
            .join('\n')
        : '';
      break;
    case 'agentMessage':
      result.kind = 'message';
      result.role = 'assistant';
      result.label = '助手';
      text = string(item.text);
      break;
    case 'commandExecution':
      result.kind = 'command';
      result.label = '命令';
      toolResult(result, item, ['inProgress', 'completed', 'failed', 'declined']);
      if (Number.isSafeInteger(item.exitCode)) result.exitCode = Number(item.exitCode);
      text = `${string(item.command)}\n${string(item.aggregatedOutput)}`.trim();
      break;
    case 'fileChange':
      result.kind = 'files';
      result.label = '文件变更';
      toolResult(result, item, ['inProgress', 'completed', 'failed', 'declined']);
      text = Array.isArray(item.changes)
        ? item.changes.map((change) => (object(change) ? string(change.path) : '')).join('\n')
        : '';
      break;
    case 'plan':
      result.kind = 'plan';
      result.label = '计划';
      text = string(item.text);
      break;
    case 'reasoning':
      result.kind = 'reasoning';
      result.label = '思考';
      text = '思考过程已隐藏';
      break;
    case 'mcpToolCall':
      result.kind = 'tool';
      result.label = 'MCP 工具';
      toolResult(result, item, ['inProgress', 'completed', 'failed']);
      text = `${string(item.server)} / ${string(item.tool)}`;
      break;
    case 'dynamicToolCall':
      result.kind = 'tool';
      result.label = '工具';
      toolResult(result, item, ['inProgress', 'completed', 'failed']);
      text = string(item.tool);
      break;
    case 'collabAgentToolCall':
      result.kind = 'agent';
      result.label = '协作事件';
      toolResult(result, item, ['inProgress', 'completed', 'failed', 'interrupted']);
      text = string(item.tool);
      break;
    case 'subAgentActivity':
      result.kind = 'agent';
      result.label = '子任务活动';
      text = string(item.kind);
      break;
    case 'contextCompaction':
      result.kind = 'tool';
      result.label = '上下文整理';
      break;
    default:
      text = `类型：${cut(string(item.type), 80) || 'unknown'}；仅保留记录身份。`;
  }
  result.text = cut(text, maximum);
  result.truncated = result.text.length < text.length;
  return result;
}

/** One thread, one connection epoch. Sequence counts ALL notifications delivered to this projection. */
export class ThreadProjection {
  private epoch: number;
  private sequence = 0;
  private needsSnapshot = false;
  private truncated = false;
  private items = new Map<string, ItemView>();
  private turns = new Map<string, TurnView>();
  private totalText = 0;
  private limits: ProjectionLimits;
  readonly threadId: string;
  constructor(threadId: string, epoch = 1, limits: Partial<ProjectionLimits> = {}) {
    if (!identity(threadId) || !Number.isSafeInteger(epoch) || epoch < 1)
      throw new Error('INVALID_PROJECTION_IDENTITY');
    this.epoch = epoch;
    this.threadId = threadId;
    this.limits = { ...defaults, ...limits };
    if (Object.values(this.limits).some((value) => !Number.isSafeInteger(value) || value < 1))
      throw new Error('INVALID_PROJECTION_LIMITS');
  }
  reconnect(epoch: number): void {
    if (!Number.isSafeInteger(epoch) || epoch <= this.epoch)
      throw new Error('STALE_CONNECTION_EPOCH');
    this.epoch = epoch;
    this.sequence = 0;
    this.needsSnapshot = true;
  }
  disconnect(): void {
    this.needsSnapshot = true;
  }
  private key(turnId: string, itemId: string): string {
    return JSON.stringify([turnId, itemId]);
  }
  private turn(id: string, status: unknown): void {
    if (!identity(id)) return;
    const previous = this.turns.get(id);
    if (!previous && this.turns.size >= this.limits.turns) {
      this.truncated = true;
      return;
    }
    // A late start must not reopen a terminal turn.
    if (previous && ['completed', 'failed', 'interrupted'].includes(previous.status)) return;
    this.turns.set(id, { id, status: turnStatus(status) });
  }
  private put(value: ItemView): void {
    const key = this.key(value.turnId, value.id);
    const previous = this.items.get(key);
    if (!previous && this.items.size >= this.limits.items) {
      this.truncated = true;
      return;
    }
    const maximum = Math.min(
      this.limits.itemText,
      this.limits.totalText - this.totalText + (previous?.text.length ?? 0),
    );
    const text = cut(value.text, maximum);
    value = { ...value, text, truncated: value.truncated || text.length < value.text.length };
    this.totalText += text.length - (previous?.text.length ?? 0);
    this.items.set(key, value);
  }
  private fullItem(turnId: string, item: unknown, complete: boolean): void {
    if (!object(item)) return;
    const value = itemView(turnId, item, complete, this.limits.itemText);
    if (!value) return;
    if (!this.turns.has(turnId)) this.turn(turnId, 'unknown');
    if (!this.turns.has(turnId)) return;
    const previous = this.items.get(this.key(turnId, value.id));
    if (
      !complete &&
      (previous || ['completed', 'failed', 'interrupted'].includes(this.turns.get(turnId)!.status))
    )
      return;
    this.put(value);
  }
  receive(epoch: number, sequence: number, message: unknown): void {
    if (epoch !== this.epoch || !Number.isSafeInteger(sequence) || sequence <= this.sequence)
      return;
    if (sequence !== this.sequence + 1) this.needsSnapshot = true;
    this.sequence = sequence;
    if (
      this.needsSnapshot ||
      !object(message) ||
      !object(message.params) ||
      message.params.threadId !== this.threadId
    )
      return;
    const p = message.params;
    if (
      (message.method === 'turn/started' || message.method === 'turn/completed') &&
      object(p.turn) &&
      identity(p.turn.id)
    ) {
      const complete = message.method === 'turn/completed';
      if (complete && Array.isArray(p.turn.items))
        for (const item of p.turn.items) this.fullItem(p.turn.id, item, true);
      this.turn(p.turn.id, p.turn.status);
      return;
    }
    if (!identity(p.turnId)) return;
    if (
      (message.method === 'item/started' || message.method === 'item/completed') &&
      object(p.item)
    ) {
      this.fullItem(p.turnId, p.item, message.method === 'item/completed');
      return;
    }
    if (
      (message.method === 'item/agentMessage/delta' ||
        message.method === 'item/plan/delta' ||
        message.method === 'item/commandExecution/outputDelta') &&
      identity(p.itemId) &&
      typeof p.delta === 'string'
    ) {
      const key = this.key(p.turnId, p.itemId);
      const previous = this.items.get(key);
      const turn = this.turns.get(p.turnId);
      if (
        previous?.status === 'complete' ||
        (turn && turn.status !== 'inProgress' && turn.status !== 'unknown')
      )
        return;
      if (!turn) this.turn(p.turnId, 'unknown');
      if (!this.turns.has(p.turnId)) return;
      const value =
        previous ??
        itemView(
          p.turnId,
          {
            id: p.itemId,
            type:
              message.method === 'item/agentMessage/delta'
                ? 'agentMessage'
                : message.method === 'item/plan/delta'
                  ? 'plan'
                  : 'commandExecution',
          },
          false,
        )!;
      // A clipped item keeps its prefix; later deltas cannot turn a partial suffix into an apparent full result.
      if (value.truncated) return;
      this.put({
        ...value,
        text: value.text + cut(p.delta, this.limits.itemText + 1),
        truncated: p.delta.length > this.limits.itemText + 1,
      });
    }
  }
  replaceSnapshot(
    epoch: number,
    sequence: number,
    turns: readonly { id: string; status: unknown; items: readonly unknown[] }[],
  ): void {
    if (epoch !== this.epoch || !Number.isSafeInteger(sequence) || sequence < this.sequence)
      throw new Error('STALE_SNAPSHOT');
    this.items.clear();
    this.turns.clear();
    this.totalText = 0;
    this.truncated = false;
    for (const turn of turns.slice(0, this.limits.turns)) {
      this.turn(turn.id, turn.status);
      for (const item of turn.items.slice(0, this.limits.items))
        this.fullItem(turn.id, item, turn.status !== 'inProgress');
      if (turn.items.length > this.limits.items) this.truncated = true;
    }
    if (turns.length > this.limits.turns) this.truncated = true;
    this.sequence = sequence;
    this.needsSnapshot = false;
  }
  view(): ThreadView {
    return {
      threadId: this.threadId,
      epoch: this.epoch,
      sequence: this.sequence,
      needsSnapshot: this.needsSnapshot,
      truncated: this.truncated || [...this.items.values()].some((item) => item.truncated),
      unsupportedItems: [...this.items.values()].some((item) => item.kind === 'unknown'),
      turns: [...this.turns.values()].map((turn) => ({ ...turn })),
      items: [...this.items.values()].map((item) => ({ ...item })),
    };
  }
}
