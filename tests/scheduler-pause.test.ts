import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,realpathSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn,execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {DatabaseSync} from 'node:sqlite';

test('actual SIGSTOP/SIGCONT Host pause catches up one queue-only UTC occurrence with stable IDs and zero inference',{skip:process.platform==='win32',timeout:20000},async t=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),'personal-agent-scheduler-pause-'))),file=join(root,'ledger.db'),cwd=join(root,'project');mkdirSync(cwd);
  const child=spawn(process.execPath,['--disable-warning=ExperimentalWarning',resolve('tests/fixtures/scheduler-pause-worker.ts'),file,cwd],{stdio:['pipe','pipe','pipe']}),closed=once(child,'close');let buffer='',errors='';
  type Message={type:string;dueAtMs?:number;readyAtMs?:number;observedAtMs:number;pumpSteps:number;queuedTotal:number;taskStatus:string;scheduleState:string;occurrences:number;triggers:number;deliveries:number;runs:number;intents:number;reservations:number;identity:null|{occurrence_id:string;trigger_id:string;delivery_id:string;delivery_state:string}};
  const messages:Message[]=[];child.stdout.on('data',chunk=>{buffer+=String(chunk);let end:number;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);messages.push(JSON.parse(line) as Message);}});child.stderr.on('data',chunk=>{errors=(errors+String(chunk)).slice(-2000);});
  const sleep=(ms:number)=>new Promise<void>(done=>setTimeout(done,ms));
  const wait=async(type:string)=>{const deadline=Date.now()+10000;while(true){const message=messages.find(m=>m.type===type);if(message)return message;if(messages.some(m=>m.type==='error')||child.exitCode!==null||child.signalCode!==null)throw Error('PAUSE_CHILD_FAILED');if(Date.now()>deadline)throw Error('PAUSE_CHILD_TIMEOUT');await sleep(10);}};
  const state=()=>execFileSync('/bin/ps',['-o','stat=','-p',String(child.pid)],{encoding:'utf8',timeout:2000}).trim();
  const independent=()=>{const db=new DatabaseSync(file,{readOnly:true});try{return{occurrences:Number(db.prepare('SELECT count(*) AS n FROM schedule_occurrences').get()!.n),triggers:Number(db.prepare('SELECT count(*) AS n FROM incoming_triggers').get()!.n),deliveries:Number(db.prepare('SELECT count(*) AS n FROM trigger_deliveries').get()!.n),runs:Number(db.prepare('SELECT count(*) AS n FROM task_runs').get()!.n),intents:Number(db.prepare('SELECT count(*) AS n FROM execution_intents').get()!.n),status:db.prepare('SELECT status FROM tasks').get()!.status};}finally{db.close();}};
  try{
    const ready=await wait('ready');assert.ok(child.pid&&child.pid>1&&child.pid!==process.pid);assert.equal(ready.taskStatus,'waiting_trigger');assert.equal(ready.occurrences,0);assert.ok(ready.dueAtMs!>Date.now());assert.equal(child.kill('SIGSTOP'),true);
    const deadline=Date.now()+2000;let stoppedState='';while(!stoppedState.includes('T')){if(Date.now()>deadline)throw Error('HOST_NOT_STOPPED');stoppedState=state();if(!stoppedState.includes('T'))await sleep(10);}
    const stoppedAtMs=Date.now();assert.ok(stoppedAtMs<ready.dueAtMs!,'Host must be observed stopped before its real due time');
    await sleep(Math.max(0,ready.dueAtMs!+250-Date.now()));assert.ok(Date.now()>ready.dueAtMs!);assert.ok(state().includes('T'));assert.deepEqual(independent(),{occurrences:0,triggers:0,deliveries:0,runs:0,intents:0,status:'waiting_trigger'});
    const resumedAtMs=Date.now();assert.equal(child.kill('SIGCONT'),true);const queued=await wait('queued');assert.ok(queued.observedAtMs>=resumedAtMs);assert.ok(queued.observedAtMs>ready.dueAtMs!);assert.equal(queued.queuedTotal,1);assert.equal(queued.taskStatus,'queued');assert.equal(queued.scheduleState,'fulfilled');assert.deepEqual([queued.occurrences,queued.triggers,queued.deliveries,queued.runs,queued.intents,queued.reservations],[1,1,1,0,0,0]);assert.equal(queued.identity?.delivery_state,'acknowledged');
    await sleep(250);child.stdin.write('check\n');const checked=await wait('checked');assert.ok(checked.pumpSteps>queued.pumpSteps);assert.equal(checked.queuedTotal,1);assert.deepEqual(checked.identity,queued.identity);assert.deepEqual([checked.occurrences,checked.triggers,checked.deliveries,checked.runs,checked.intents,checked.reservations],[1,1,1,0,0,0]);assert.deepEqual(independent(),{occurrences:1,triggers:1,deliveries:1,runs:0,intents:0,status:'queued'});
    child.stdin.end('quit\n');const [exitCode,signal]=await closed;assert.equal(exitCode,0);assert.equal(signal,null);assert.equal(errors,'');assert.ok(messages.some(m=>m.type==='finished'));
    t.diagnostic('SCHEDULER_PAUSE_RECEIPT '+JSON.stringify({scope:'actual_Node_Host_pause_resume_not_physical_device_sleep',clock:'real_Date.now_UTC_no_injection',dueAtMs:ready.dueAtMs,stoppedAtMs,resumedAtMs,queuedAtMs:queued.observedAtMs,observedPsState:stoppedState,queueCount:checked.queuedTotal,identity:checked.identity,occurrences:checked.occurrences,triggers:checked.triggers,deliveries:checked.deliveries,pumpSteps:checked.pumpSteps,modelRuns:checked.runs,executionIntents:checked.intents,budgetReservations:checked.reservations,modelInferenceRequested:false,physicalDeviceSleepTested:false,exitCode}));
  }finally{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await closed.catch(()=>{});}rmSync(root,{recursive:true,force:true});}
});
