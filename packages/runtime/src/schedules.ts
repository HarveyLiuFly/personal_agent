import { ExecutionLedger, LedgerError } from '../../store/src/ledger.ts';
import { isObject } from '../../codex-adapter/src/rpc.ts';
import type { ForegroundExecution } from './execution.ts';
const identifier = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= 200 && !/[\x00-\x1f]/.test(v);
/** Fixed queue-only controls. The clock, Source identity and dispatch authority are never Renderer inputs. */
export class ScheduleService {
  private store: ExecutionLedger;
  private execution?: ForegroundExecution;
  private cursor = 0;
  constructor(store: ExecutionLedger, execution?: ForegroundExecution) {
    this.store = store;
    this.execution = execution;
  }
  apply(input: unknown) {
    return this.store.scheduleCommand(input);
  }
  list(input: unknown) {
    if (
      !isObject(input) ||
      Object.keys(input).length !== 1 ||
      !Object.hasOwn(input, 'projectId') ||
      !identifier(input.projectId)
    )
      throw new LedgerError('INVALID_SCHEDULE_QUERY');
    return this.store.schedules(input.projectId);
  }
  occurrences(input: unknown) {
    if (
      !isObject(input) ||
      Object.keys(input).length !== 2 ||
      !['projectId', 'scheduleId'].every((k) => Object.hasOwn(input, k) && identifier(input[k]))
    )
      throw new LedgerError('INVALID_SCHEDULE_QUERY');
    return this.store.scheduleOccurrences(input.projectId as string, input.scheduleId as string);
  }
  step() {
    const scheduled = this.store.stepSchedules(),
      delivered = this.store.deliverScheduleWakes();
    // Dispatch only while another Run can be admitted; the ledger still enforces capacity.
    if (this.execution && !this.execution.atCapacity) {
      const candidates = this.store.scheduledCandidates();
      for (let n = 0; n < Math.min(20, candidates.length); n++) {
        const candidate = candidates[(this.cursor + n) % candidates.length]!;
        try {
          this.execution.startScheduled(candidate.projectId, candidate.triggerId);
          this.cursor = (this.cursor + n + 1) % Math.max(1, candidates.length);
          break;
        } catch (error) {
          if (!(error instanceof LedgerError)) throw error;
          this.store.scheduleDispatchWait(candidate.projectId, candidate.triggerId, error.code);
        }
      }
      this.cursor = (this.cursor + 20) % Math.max(1, candidates.length);
    }
    if (this.execution && !this.execution.atCapacity)
      for (const candidate of this.store.goalDispatchCandidates()) {
        try {
          this.execution.startTask(candidate);
          break;
        } catch (error) {
          if (!(error instanceof LedgerError))
            throw error; /* No Run means no dispatch; sent/Unknown candidates disappear permanently. */
        }
      }
    return { ...scheduled, ...delivered };
  }
}
