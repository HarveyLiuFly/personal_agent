import {ExecutionLedger,LedgerError} from '../../store/src/ledger.ts';
import {isObject} from '../../codex-adapter/src/rpc.ts';
const identifier=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<=200&&!/[\x00-\x1f]/.test(v);
/** Fixed queue-only controls. The clock, Source identity and dispatch authority are never Renderer inputs. */
export class ScheduleService {
 private store:ExecutionLedger;
 constructor(store:ExecutionLedger){this.store=store;}
 apply(input:unknown){return this.store.scheduleCommand(input);}
 list(input:unknown){if(!isObject(input)||Object.keys(input).length!==1||!Object.hasOwn(input,'projectId')||!identifier(input.projectId))throw new LedgerError('INVALID_SCHEDULE_QUERY');return this.store.schedules(input.projectId);}
 occurrences(input:unknown){if(!isObject(input)||Object.keys(input).length!==2||!['projectId','scheduleId'].every(k=>Object.hasOwn(input,k)&&identifier(input[k])))throw new LedgerError('INVALID_SCHEDULE_QUERY');return this.store.scheduleOccurrences(input.projectId as string,input.scheduleId as string);}
 step(){const scheduled=this.store.stepSchedules(),delivered=this.store.deliverScheduleWakes();return{...scheduled,...delivered};}
}
