import type {App,BrowserWindow} from 'electron';
import {writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import type {ExecutionLedger} from '../../../packages/store/src/ledger.ts';
/** Real renderer and durable stdio workflow; ALL tool items below come from a synthetic server. */
export async function runToolProbe(root:string,app:App,window:BrowserWindow,store:ExecutionLedger){
  const result=await window.webContents.executeJavaScript(`(async()=>{
    const wait=async f=>{const until=Date.now()+15000;while(!f()){if(Date.now()>until)throw Error('TOOLS_UI_TIMEOUT');await new Promise(r=>setTimeout(r,30));}},click=async s=>{await wait(()=>document.querySelector(s)&&!document.querySelector(s).disabled);document.querySelector(s).click();},select=async(s,value)=>{const e=document.querySelector(s);Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(e,value);e.dispatchEvent(new Event('change',{bubbles:true}));await new Promise(r=>setTimeout(r,60));};
    await click('[data-action="choose-project"]');await wait(()=>document.querySelector('[data-task-draft]'));
    const input=document.querySelector('[data-task-draft]');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'Public tool display fixture');input.dispatchEvent(new Event('input',{bubbles:true}));await click('[data-action="send"]');
    await wait(()=>document.querySelector('[data-tool-id="pending"][data-tool-state="inProgress"]'));const liveObserved=true;
    await wait(()=>document.querySelector('[data-run-status="completed"]')&&document.querySelector('[data-tool-id="pending"][data-tool-state="unknown"]'));
    const states=Object.fromEntries([...document.querySelectorAll('[data-tool-id]')].map(e=>[e.dataset.toolId,e.dataset.toolState]));
    const count=document.querySelector('[data-tool-count]').textContent==='7 条可见记录';
    await select('[data-tool-filter]','failed');const failedFilter=document.querySelectorAll('[data-tool-id]').length===2;
    await select('[data-tool-kind]','files');const emptyFilter=document.querySelectorAll('[data-tool-id]').length===0&&Boolean(document.querySelector('[data-tools-empty]'));
    await select('[data-tool-filter]','all');const filesFilter=document.querySelectorAll('[data-tool-id]').length===2;
    await select('[data-tool-kind]','all');for(const id of ['failed','files'])document.querySelector('[data-tool-id="'+id+'"]').open=true;
    const plainText=!document.querySelector('[data-agent-tools] img')&&document.querySelector('[data-tool-id="failed"] [data-tool-text]').textContent.includes('<img src=x onerror=alert(1)>');
    const noSecrets=!document.querySelector('[data-agent-tools]').textContent.includes('DO_NOT_COPY');
    const state=await window.personalAgent.workspaceState(),projectId=state.value.projects[0].id,rows=await window.personalAgent.listRuns({projectId}),view=await window.personalAgent.getRun({projectId,runId:rows.value[0].runId});
    document.querySelector('[data-agent-tools]').scrollIntoView();return{projectId,runId:view.value.runId,liveObserved,count,failedFilter,emptyFilter,filesFilter,plainText,noSecrets,states,taskNeedsReview:view.value.taskStatus==='needs_review',sandboxed:window.personalAgent.security.sandboxed,isolated:window.personalAgent.security.isolated,noRequire:typeof require==='undefined',apiCount:Object.keys(window.personalAgent).length===63};
  })()`);
  const {projectId,runId,states,...checks}=result;
  const expected={ok:'completed',failed:'failed',declined:'declined',files:'completed',pending:'unknown',mcp:'failed',legacy:'unknown'};
  const passed=Object.values(checks).every(Boolean)&&JSON.stringify(states)===JSON.stringify(expected)&&store.runs(projectId).length===1;
  writeFileSync(resolve(root,'docs/progress/evidence/screenshots/M2.1b-tools-fixture.png'),(await window.webContents.capturePage()).toPNG());
  writeFileSync(resolve(root,'docs/progress/evidence/M2.1b-tools-desktop.json'),JSON.stringify({status:passed?'passed':'blocked',observedAt:new Date().toISOString(),kind:'real_electron_sqlite_synthetic_tool_items',inferenceRequested:false,toolExecutionRequested:false,history:'synthetic_metadata',result:{...checks,states,oneSyntheticRun:store.runs(projectId).length===1}},null,2)+'\n');app.quit();
}
