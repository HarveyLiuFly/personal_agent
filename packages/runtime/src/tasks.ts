import {ExecutionLedger,LedgerError} from '../../store/src/ledger.ts';
import {ForegroundExecution} from './execution.ts';
import {isObject} from '../../codex-adapter/src/rpc.ts';
import type {TaskCommand,OperationReceipt} from '../../contracts/src/tasks.ts';
/** Fixed Domain entry points; no input can supply SQL, an executor factory, argv or an execution Grant. */
export class TaskService {
 private store:ExecutionLedger;private execution:ForegroundExecution;
 constructor(store:ExecutionLedger,execution:ForegroundExecution){this.store=store;this.execution=execution;}
 list(input:unknown){
  if(!isObject(input)||Object.keys(input).length!==1||!Object.hasOwn(input,'projectId')||typeof input.projectId!=='string')throw new LedgerError('INVALID_TASK_QUERY');return this.store.tasks(input.projectId);
 }
 activity(input:unknown){
  if(!isObject(input)||!Object.hasOwn(input,'projectId')||Object.keys(input).some(k=>!['projectId','cursor'].includes(k))||typeof input.projectId!=='string'||('cursor'in input&&(!Number.isSafeInteger(input.cursor)||Number(input.cursor)<0)))throw new LedgerError('INVALID_TASK_QUERY');
  return this.store.activity(input.projectId,input.cursor as number|undefined);
 }
 async apply(input:unknown):Promise<OperationReceipt>{
  if(isObject(input)&&input.kind==='create'&&'code'in input&&!this.execution.supportsQueuedCode)throw new LedgerError('CODE_EXECUTION_UNAVAILABLE');
  const command=input as TaskCommand,receipt=this.store.taskCommand(command);
  if(receipt.state==='executing'&&receipt.runId){
   try{await this.execution.interrupt({projectId:command.projectId,runId:receipt.runId});}
   catch{const run=this.store.runForHost(receipt.runId);if(['preparing','submitting','running','waiting_input','waiting_approval'].includes(run.status))this.store.uncertain({runId:run.runId,epoch:run.epoch,taskFence:run.taskFence});}
   return this.store.taskCommand(command);
  }
  return receipt;
 }
}
