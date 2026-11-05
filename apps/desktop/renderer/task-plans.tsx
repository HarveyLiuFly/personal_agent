import React, { useEffect, useRef, useState } from 'react';
import type { TaskSummary, TaskPlanView } from '../../../packages/contracts/src/tasks.ts';
import type { HostResult } from '../../../packages/contracts/src/views.ts';
import { subscribeRefresh } from './host-events.ts';
const states: Record<string, string> = {
  pending: '等待处理',
  blocked: '等待前置操作',
  executing: '等待停止确认',
  completed: '操作已处理',
  failed: '操作失败',
  cancelled: '未执行项已撤回',
  outcome_unknown: '结果待核对',
  running: '处理中',
  needs_review: '部分操作需处理',
};
const kinds: Record<string, string> = {
  pause: '暂停',
  cancel: '取消',
  resume: '恢复排队',
  rename: '改名',
};
async function value<T>(p: Promise<HostResult<T>>) {
  const r = await p;
  if (!r.ok) throw new Error(r.errorCode);
  return r.value;
}
export function TaskPlans({
  projectId,
  tasks,
  busy,
  perform,
}: {
  projectId: string;
  tasks: TaskSummary[];
  busy: boolean;
  perform: (work: () => Promise<void>) => Promise<void>;
}) {
  const [selected, setSelected] = useState<Record<string, number>>({}),
    [plans, setPlans] = useState<TaskPlanView[]>([]),
    [loadError, setLoadError] = useState(false);
  const key = useRef<string | undefined>(undefined),
    cancelKeys = useRef(new Map<string, string>());
  useEffect(() => {
    let stopped = false;
    const poll = async () => {
      try {
        const rows = await value(window.personalAgent.listTaskPlans({ projectId }));
        if (!stopped) {
          setPlans(rows);
          setLoadError(false);
        }
      } catch {
        if (!stopped) setLoadError(true);
      }
    };
    // Re-read after each Host change notice instead of polling.
    const unsubscribe = subscribeRefresh(poll);
    return () => {
      stopped = true;
      unsubscribe();
    };
  }, [projectId]);
  const ids = Object.keys(selected).sort(),
    eligible = tasks.filter(
      (t) => !['completed', 'cancelled', 'outcome_unknown'].includes(t.status) && !t.blocked,
    );
  const apply = (kind: 'pause' | 'cancel') =>
    perform(async () => {
      key.current ??= crypto.randomUUID();
      await value(
        window.personalAgent.applyTaskPlan({
          projectId,
          commandKey: key.current,
          nodes: ids.map((taskId) => ({
            kind,
            taskId,
            expectedVersion: selected[taskId]!,
            dependsOn: [],
          })),
        }),
      );
      setSelected({});
      key.current = undefined;
    });
  return (
    <section aria-label="批量任务操作" data-task-plans>
      <h3>批量操作</h3>
      <p className="history-note">
        每批最多 20 项，使用选中时的任务版本；单项失败不撤销其他已处理项。
      </p>
      <div className="queue-actions">
        {eligible.map((task) => (
          <label key={task.taskId}>
            <input
              type="checkbox"
              data-plan-select={task.taskId}
              checked={Object.hasOwn(selected, task.taskId)}
              disabled={busy || (!Object.hasOwn(selected, task.taskId) && ids.length >= 20)}
              onChange={(e) => {
                key.current = undefined;
                setSelected((previous) => {
                  const next = { ...previous };
                  if (e.target.checked) next[task.taskId] = task.version;
                  else delete next[task.taskId];
                  return next;
                });
              }}
            />
            {task.title}
          </label>
        ))}
      </div>
      <div className="queue-actions">
        <button
          data-plan-action="pause"
          disabled={busy || !ids.length}
          onClick={() => void apply('pause')}
        >
          暂停所选（{ids.length}）
        </button>
        <button
          data-plan-action="cancel"
          disabled={busy || !ids.length}
          onClick={() => void apply('cancel')}
        >
          取消所选（{ids.length}）
        </button>
      </div>
      {loadError && <p role="alert">无法更新批量操作记录。</p>}
      {plans.map((plan) => (
        <article
          className="queue-task"
          data-task-plan={plan.planId}
          data-plan-status={plan.status}
          key={plan.planId}
        >
          <strong>{states[plan.status]}</strong>
          <ol>
            {plan.operations.map((op) => (
              <li key={op.operationId} data-plan-node={op.index} data-plan-node-status={op.state}>
                {kinds[op.kind]} ·{' '}
                {tasks.find((t) => t.taskId === op.taskId)?.title ?? '已记录任务'} ·{' '}
                {states[op.state]}
                {op.errorCode === 'TASK_VERSION_CONFLICT'
                  ? '（任务版本已变化）'
                  : op.errorCode === 'DEPENDENCY_FAILED'
                    ? '（前置操作失败）'
                    : op.errorCode && op.state === 'failed'
                      ? '（请核对任务状态）'
                      : ''}
              </li>
            ))}
          </ol>
          {plan.operations.some((op) => op.state === 'pending' || op.state === 'blocked') && (
            <button
              data-plan-action="withdraw"
              disabled={busy}
              onClick={() =>
                void perform(async () => {
                  let commandKey = cancelKeys.current.get(plan.planId);
                  if (!commandKey) {
                    commandKey = crypto.randomUUID();
                    cancelKeys.current.set(plan.planId, commandKey);
                  }
                  await value(
                    window.personalAgent.cancelTaskPlan({
                      projectId,
                      planId: plan.planId,
                      commandKey,
                    }),
                  );
                })
              }
            >
              撤回未执行项
            </button>
          )}
        </article>
      ))}
    </section>
  );
}
