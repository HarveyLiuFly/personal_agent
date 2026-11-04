import type {App,BrowserWindow} from 'electron';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import type {ForegroundExecution} from '../../../packages/runtime/src/execution.ts';
/** Fixed public UI fixture; no evaluation or fixture controls are exposed through IPC. */
export async function runPlanProbe(root:string,app:App,window:BrowserWindow,execution:ForegroundExecution){
 const result=await window.webContents.executeJavaScript(`(async()=>{
  const wait=async(check)=>{const deadline=Date.now()+15000;while(!await check()){if(Date.now()>deadline)throw new Error('PLAN_UI_TIMEOUT');await new Promise(r=>setTimeout(r,30));}};
  const call=async(p)=>{const r=await p;if(!r.ok)throw new Error(r.errorCode);return r.value;};
  document.querySelector('[data-action="choose-project"]').click();await wait(()=>document.querySelector('[data-action="open-tasks"]')&&!document.querySelector('[data-action="open-tasks"]').disabled);document.querySelector('[data-action="open-tasks"]').click();await wait(()=>document.querySelector('[data-task-manager]'));document.querySelector('[data-task-manager]').open=true;
  const projectId=(await call(window.personalAgent.workspaceState())).projects[0].id;
  const tasks=[];for(let n=0;n<3;n++)tasks.push(await call(window.personalAgent.applyTaskCommand({projectId,commandKey:'plan-ui-create-'+n,kind:'create',text:'Public batch task '+n})));
  await wait(()=>document.querySelectorAll('[data-plan-select]').length===3);for(const box of document.querySelectorAll('[data-plan-select]')){box.click();await new Promise(r=>setTimeout(r,30));}
  document.querySelector('[data-plan-action="pause"]').click();await wait(()=>document.querySelectorAll('[data-queued-status="paused"]').length===3&&document.querySelector('[data-plan-status="completed"]'));
  const allPaused=(await call(window.personalAgent.listTasks({projectId}))).every(t=>t.status==='paused');
  for(const task of tasks.slice(0,2)){const current=(await call(window.personalAgent.listTasks({projectId}))).find(t=>t.taskId===task.taskId);await call(window.personalAgent.applyTaskCommand({projectId,commandKey:'resume-'+task.taskId,kind:'resume',taskId:task.taskId,expectedVersion:current.version}));}
  await wait(()=>document.querySelectorAll('[data-plan-select]').length===2);for(const box of document.querySelectorAll('[data-plan-select]')){box.click();await new Promise(r=>setTimeout(r,30));}
  const first=(await call(window.personalAgent.listTasks({projectId}))).find(t=>t.taskId===tasks[0].taskId);await call(window.personalAgent.applyTaskCommand({projectId,commandKey:'external-plan-ui-edit',kind:'rename',taskId:first.taskId,expectedVersion:first.version,title:'Changed after selection'}));
  document.querySelector('[data-plan-action="cancel"]').click();await wait(()=>document.querySelector('[data-plan-status="needs_review"]'));
  const partial=(await call(window.personalAgent.listTaskPlans({projectId}))).find(p=>p.status==='needs_review');
  const third=(await call(window.personalAgent.listTasks({projectId}))).find(t=>t.taskId===tasks[2].taskId),nodes=Array.from({length:20},(_,n)=>({kind:'rename',taskId:third.taskId,title:'Public retained edit '+n,...(n===0?{expectedVersion:third.version}:{versionFrom:n-1}),dependsOn:n===0?[]:[n-1]}));
  const withdrawal=await call(window.personalAgent.applyTaskPlan({projectId,commandKey:'withdraw-ui-plan',nodes}));
  await wait(()=>document.querySelector('[data-task-plan="'+withdrawal.planId+'"] [data-plan-action="withdraw"]'));document.querySelector('[data-task-plan="'+withdrawal.planId+'"] [data-plan-action="withdraw"]').click();
  await wait(async()=>{const p=(await call(window.personalAgent.listTaskPlans({projectId}))).find(p=>p.planId===withdrawal.planId);return p.operations.some(o=>o.state==='cancelled');});
  const withdrawn=(await call(window.personalAgent.listTaskPlans({projectId}))).find(p=>p.planId===withdrawal.planId),final=(await call(window.personalAgent.listTasks({projectId}))).find(t=>t.taskId===third.taskId);
  const invalid=await window.personalAgent.applyTaskPlan({projectId,commandKey:'bad-ui-plan',nodes:[{kind:'pause',taskId:first.taskId,expectedVersion:first.version,dependsOn:[0]}]});
  const foreign=await window.personalAgent.listTaskPlans({projectId,sql:'SELECT secret'});
  await wait(()=>!document.querySelector('[data-task-plan="'+withdrawal.planId+'"] [data-plan-action="withdraw"]'));document.querySelector('[data-task-plan="'+partial.planId+'"]').scrollIntoView({block:'start'});await new Promise(r=>setTimeout(r,60));
  return{allPaused,partialFailureShown:partial.operations.filter(o=>o.state==='failed'&&o.errorCode==='TASK_VERSION_CONFLICT').length===1&&partial.operations.filter(o=>o.state==='completed').length===1,selectionVersionPreserved:(await call(window.personalAgent.listTasks({projectId}))).find(t=>t.taskId===first.taskId).status==='queued',withdrawalKeptCommitted:withdrawn.operations.some(o=>o.state==='completed')&&final.title.startsWith('Public retained edit '),withdrawalCancelledPending:withdrawn.operations.some(o=>o.state==='cancelled')&&!withdrawn.operations.some(o=>['pending','blocked'].includes(o.state)),invalidRejected:!invalid.ok,extraRejected:!foreign.ok,noModelRuns:(await call(window.personalAgent.listRuns({projectId}))).length===0,sandboxed:window.personalAgent.security.sandboxed,isolated:window.personalAgent.security.isolated,hasRequire:typeof require!=='undefined'};
 })()`);
 const passed=Object.entries(result).every(([k,v])=>k==='hasRequire'?v===false:v===true)&&execution.diagnostics.clientTurnStarts===0;
 writeFileSync(join(root,'docs/progress/evidence/M2.2d-desktop.json'),JSON.stringify({status:passed?'passed':'blocked',observedAt:new Date().toISOString(),kind:'real_electron_and_sqlite_task_plans',backend:'synthetic_stdio_not_called',folderDialogSelection:'fixed_fixture_substitution',inferenceRequested:false,modelTurns:0,result},null,2)+'\n');
 writeFileSync(join(root,'.local/M2-task-plans-desktop.png'),(await window.webContents.capturePage()).toPNG());app.quit();
}
