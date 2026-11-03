import {readFileSync,writeSync} from 'node:fs';
import {createInterface} from 'node:readline';
import {DatabaseSync} from 'node:sqlite';
import {ExecutionLedger} from '../../packages/store/src/ledger.ts';
import {ScheduleService} from '../../packages/runtime/src/schedules.ts';

const [file,cwd]=process.argv.slice(2) as [string,string];
// Real wall clock and a single actual Host. No schedulerClock, executor, model or PTY factory is installed.
const store=new ExecutionLedger(file,readFileSync('docs/design/contracts/schema.sql','utf8'));store.startOwner('actual-pause-fixture',true);
const project=store.registerWorkspace(cwd),service=new ScheduleService(store),task=store.taskCommand({kind:'create',projectId:project.id,commandKey:'pause-task',text:'PUBLIC_QUEUE_ONLY_PAUSE_FIXTURE'}),dueAtMs=Date.now()+1500;
const schedule=service.apply({kind:'create',projectId:project.id,taskId:task.taskId,expectedTaskVersion:task.taskVersion,commandKey:'pause-schedule',config:{kind:'once',timezone:'UTC',atMs:dueAtMs,expiresAtMs:dueAtMs+15000,misfirePolicy:'coalesce',overlapPolicy:'coalesce',maxCatchUp:1,dispatchMode:'queue_only'}});
let pumpSteps=0,queuedTotal=0;
function snapshot(){const db=new DatabaseSync(file,{readOnly:true});try{const count=(table:string)=>Number(db.prepare('SELECT count(*) AS n FROM '+table).get()!.n);return{observedAtMs:Date.now(),pumpSteps,queuedTotal,taskStatus:store.tasks(project.id)[0]!.status,scheduleState:store.schedules(project.id)[0]!.state,occurrences:count('schedule_occurrences'),triggers:count('incoming_triggers'),deliveries:count('trigger_deliveries'),runs:count('task_runs'),intents:count('execution_intents'),reservations:count('budget_reservations'),identity:db.prepare('SELECT o.occurrence_id,o.trigger_id,d.delivery_id,d.state AS delivery_state FROM schedule_occurrences o JOIN trigger_deliveries d USING(trigger_id)').get()??null};}finally{db.close();}}
function emit(type:string){writeSync(1,JSON.stringify({type,...snapshot()})+'\n');}
const timer=setInterval(()=>{try{const result=service.step();pumpSteps++;queuedTotal+=result.queued;if(result.queued)emit('queued');}catch{clearInterval(timer);writeSync(1,JSON.stringify({type:'error',code:'PAUSE_PUMP_FAILED'})+'\n');process.exit(1);}},25);
writeSync(1,JSON.stringify({type:'ready',projectId:project.id,taskId:task.taskId,scheduleId:schedule.scheduleId,dueAtMs,readyAtMs:Date.now(),...snapshot()})+'\n');
for await(const command of createInterface({input:process.stdin})){
  if(command==='check')emit('checked');
  if(command==='quit'){clearInterval(timer);emit('finished');store.close();process.stdin.destroy();break;}
}
