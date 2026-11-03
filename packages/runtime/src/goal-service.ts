import type {GoalCommand,GoalCommandResult,GoalNotificationClaim} from '../../contracts/src/goals.ts';
import {LedgerError} from '../../store/src/ledger.ts';
import type {ExecutionLedger} from '../../store/src/ledger.ts';
import type {ForegroundExecution} from './execution.ts';
import type {AuthenticatedSourcePoller} from './source-poller.ts';

export interface GoalNotificationReceipt {state:'delivered'|'failed'|'unknown';providerRef:string|null}
export interface GoalServiceOptions {
 /** Already constructed by Host. No URL, credentials, identity binding or grants enter through this service. */
 sourcePoller?:AuthenticatedSourcePoller;
 /** Each reader returns the latest committed, non-secret Source cursor, including after restart. */
 sources?:Array<{sourceId:string;cursor:()=>unknown}>;
 /** Host owns the Provider adapter; a thrown error or missing acknowledgement is Unknown. */
 send?:(claim:GoalNotificationClaim,signal:AbortSignal)=>Promise<GoalNotificationReceipt>;
 notificationTimeoutMs?:number;
 notificationLimit?:number;
}
export interface GoalTickResult {
 polled:number;sourceErrors:number;
 goals:ReturnType<ExecutionLedger['stepGoals']>;
 notifications:{delivered:number;failed:number;unknown:number};
}
/** A bounded Host tick, not an execution loop. Task admission remains with the existing execution pump. */
export class GoalService {
 private store:ExecutionLedger;private execution:Pick<ForegroundExecution,'interrupt'>;private options:GoalServiceOptions;
 private pending?:Promise<GoalTickResult>;
 constructor(store:ExecutionLedger,execution:Pick<ForegroundExecution,'interrupt'>,options:GoalServiceOptions={}){
  if((options.sources?.length??0)>100||options.sources?.some(s=>!s||typeof s.sourceId!=='string'||!s.sourceId||s.sourceId.length>200||/[\x00-\x1f]/.test(s.sourceId)||typeof s.cursor!=='function')||new Set(options.sources?.map(s=>s.sourceId)).size!==(options.sources?.length??0)||options.sources?.length&&!options.sourcePoller||options.notificationTimeoutMs!==undefined&&(!Number.isSafeInteger(options.notificationTimeoutMs)||options.notificationTimeoutMs<1||options.notificationTimeoutMs>60000)||options.notificationLimit!==undefined&&(!Number.isSafeInteger(options.notificationLimit)||options.notificationLimit<1||options.notificationLimit>100))throw new LedgerError('INVALID_GOAL_SERVICE_OPTIONS');
  this.store=store;this.execution=execution;this.options={...options,sources:options.sources?.map(source=>({...source}))};
 }
 async apply(command:GoalCommand):Promise<GoalCommandResult>{
  const result=this.store.applyGoal(command);
  if(!result.duplicate)for(const runId of new Set(result.affectedRunIds)){
   const run=this.store.runForHost(runId);
   if(['completed','failed','cancelled','outcome_unknown'].includes(run.status))continue;
   try{await this.execution.interrupt({projectId:run.workspaceId,runId});}
   catch{this.store.uncertain({runId,epoch:run.epoch,taskFence:run.taskFence});}
  }
  return result;
 }
 tick():Promise<GoalTickResult>{
  if(this.pending)return this.pending;
  const pending=this.step().finally(()=>{if(this.pending===pending)this.pending=undefined;});this.pending=pending;return pending;
 }
 async wait():Promise<void>{await this.pending;}
 private async send(claim:GoalNotificationClaim):Promise<GoalNotificationReceipt>{
  const abort=new AbortController();let timer:NodeJS.Timeout|undefined;
  try{
   return await Promise.race([Promise.resolve().then(()=>this.options.send!(Object.freeze({...claim}),abort.signal)),new Promise<GoalNotificationReceipt>(resolve=>{timer=setTimeout(()=>{abort.abort();resolve({state:'unknown',providerRef:null});},this.options.notificationTimeoutMs??5000);})]);
  }catch{return{state:'unknown',providerRef:null};}finally{if(timer)clearTimeout(timer);}
 }
 private async step():Promise<GoalTickResult>{
  let polled=0,sourceErrors=0;
  for(const source of this.options.sources??[]){
   try{const envelope=await this.options.sourcePoller!.poll(source.sourceId,source.cursor());this.store.ingestGoalSource(source.sourceId,envelope);polled++;}
   catch{sourceErrors++;}
  }
  const result:GoalTickResult={polled,sourceErrors,goals:this.store.stepGoals(),notifications:{delivered:0,failed:0,unknown:0}};
  if(this.options.send)for(let i=0;i<(this.options.notificationLimit??20);i++){
   const claim=this.store.claimGoalNotification();if(!claim)break;
   let receipt=await this.send(claim);
   // A malformed Provider response cannot turn an unacknowledged send into a retryable pending item.
   if(!receipt||!['delivered','failed','unknown'].includes(receipt.state)||receipt.providerRef!==null&&(typeof receipt.providerRef!=='string'||receipt.providerRef.length<1||receipt.providerRef.length>200||/[\x00-\x1f]/.test(receipt.providerRef)))receipt={state:'unknown',providerRef:null};
   this.store.finishGoalNotification(claim,receipt);result.notifications[receipt.state]++;
  }
  return result;
 }
}
