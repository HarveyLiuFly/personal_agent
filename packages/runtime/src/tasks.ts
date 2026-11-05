import { ExecutionLedger, LedgerError } from '../../store/src/ledger.ts';
import { ForegroundExecution } from './execution.ts';
import { isObject } from '../../codex-adapter/src/rpc.ts';
import type { TaskCommand, OperationReceipt, TaskPlanView } from '../../contracts/src/tasks.ts';
const identifier = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= 200 && !/[\x00-\x1f]/.test(v);
/** Fixed Domain entry points; no input can supply SQL, an executor factory, argv or an execution Grant. */
export class TaskService {
  private store: ExecutionLedger;
  private execution: ForegroundExecution;
  private plansBusy = false;
  constructor(store: ExecutionLedger, execution: ForegroundExecution) {
    this.store = store;
    this.execution = execution;
  }
  list(input: unknown) {
    if (
      !isObject(input) ||
      Object.keys(input).length !== 1 ||
      !Object.hasOwn(input, 'projectId') ||
      !identifier(input.projectId)
    )
      throw new LedgerError('INVALID_TASK_QUERY');
    return this.store.tasks(input.projectId);
  }
  activity(input: unknown) {
    if (
      !isObject(input) ||
      !Object.hasOwn(input, 'projectId') ||
      Object.keys(input).some((k) => !['projectId', 'cursor'].includes(k)) ||
      !identifier(input.projectId) ||
      ('cursor' in input && (!Number.isSafeInteger(input.cursor) || Number(input.cursor) < 0))
    )
      throw new LedgerError('INVALID_TASK_QUERY');
    return this.store.activity(input.projectId, input.cursor as number | undefined);
  }
  async apply(input: unknown): Promise<OperationReceipt> {
    if (
      isObject(input) &&
      input.kind === 'create' &&
      'code' in input &&
      !this.execution.supportsQueuedCode
    )
      throw new LedgerError('CODE_EXECUTION_UNAVAILABLE');
    const command = input as TaskCommand,
      receipt = this.store.taskCommand(command);
    if (receipt.state === 'executing' && receipt.runId) {
      try {
        await this.execution.interrupt({ projectId: command.projectId, runId: receipt.runId });
      } catch {
        const run = this.store.runForHost(receipt.runId);
        if (
          ['preparing', 'submitting', 'running', 'waiting_input', 'waiting_approval'].includes(
            run.status,
          )
        )
          this.store.uncertain({ runId: run.runId, epoch: run.epoch, taskFence: run.taskFence });
      }
      return this.store.taskCommand(command);
    }
    return receipt;
  }
  plans(input: unknown) {
    if (
      !isObject(input) ||
      Object.keys(input).length !== 1 ||
      !Object.hasOwn(input, 'projectId') ||
      !identifier(input.projectId)
    )
      throw new LedgerError('INVALID_TASK_QUERY');
    return this.store.taskPlans(input.projectId);
  }
  async applyPlan(input: unknown): Promise<TaskPlanView> {
    const plan = this.store.submitTaskPlan(input);
    await this.stepPlans();
    return this.store.taskPlan(plan.projectId, plan.planId);
  }
  cancelPlan(input: unknown): TaskPlanView {
    if (
      !isObject(input) ||
      Object.keys(input).length !== 3 ||
      !['projectId', 'planId', 'commandKey'].every(
        (k) => Object.hasOwn(input, k) && identifier(input[k]),
      )
    )
      throw new LedgerError('INVALID_TASK_PLAN');
    return this.store.cancelTaskPlan(
      input.projectId as string,
      input.planId as string,
      input.commandKey as string,
    );
  }
  async stepPlans(): Promise<void> {
    if (this.plansBusy) return;
    this.plansBusy = true;
    try {
      for (const pending of this.store.pendingTaskPlans()) {
        try {
          const plan = this.store.advanceTaskPlan(pending.projectId, pending.planId, 1);
          for (const op of plan.operations) {
            if (op.state !== 'executing' || !op.receipt?.runId) continue;
            try {
              await this.execution.interrupt({
                projectId: plan.projectId,
                runId: op.receipt.runId,
              });
            } catch {
              const run = this.store.runForHost(op.receipt.runId);
              if (
                [
                  'preparing',
                  'submitting',
                  'running',
                  'waiting_input',
                  'waiting_approval',
                ].includes(run.status)
              )
                this.store.uncertain({
                  runId: run.runId,
                  epoch: run.epoch,
                  taskFence: run.taskFence,
                });
            }
          }
        } catch {
          /* One invalid/unavailable workspace cannot advance another plan or block its independent scope. */
        }
      }
    } finally {
      this.plansBusy = false;
    }
  }
}
