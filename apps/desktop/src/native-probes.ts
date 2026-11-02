import type {App,BrowserWindow} from 'electron';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,writeFileSync} from 'node:fs';
import {basename,dirname,join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {ExecutionLedger,hashInput} from '../../../packages/store/src/ledger.ts';
import {NodeVerification,workspaceFiles} from '../../../packages/verification/src/verification.ts';
import type {ForegroundExecution} from '../../../packages/runtime/src/execution.ts';
import {verifiedCodex} from '../../../packages/codex-adapter/src/binary.ts';
export interface NativeProbe {
 kind:'owner-primary'|'owner-secondary'|'folder'|'restart';stateDirectory:string;folderDirectory?:string;
 dialogOpened:boolean;selectionMatched:boolean;readMethods:Set<string>;
}
/** Fixed internal acceptance modes. No Renderer IPC controls paths or test execution. */
export function nativeProbe(root:string,args:readonly string[]):NativeProbe|undefined {
 const flags=[['--m1-owner-primary','owner-primary'],['--m1-owner-secondary','owner-secondary'],['--m1-native-folder-smoke','folder'],['--m1-native-restart-smoke','restart']] as const;
 const selected=flags.filter(([flag])=>args.includes(flag));if(!selected.length)return;
 if(selected.length!==1)throw new Error('INVALID_NATIVE_PROBE_FLAGS');
 const kind=selected[0]![1],local=resolve(root,'.local');mkdirSync(local,{recursive:true});let stateDirectory:string,folderDirectory:string|undefined;
 if(kind==='folder'){
  stateDirectory=mkdtempSync(join(local,'desktop-folder-smoke-'));folderDirectory=realpathSync(mkdtempSync(join(tmpdir(),'personal-agent-folder-native-')));writeFileSync(join(folderDirectory,'public-fixture.txt'),'Controlled native folder selection fixture.\n');
 }else{
  const value=args.find(arg=>arg.startsWith('--probe-state='))?.slice('--probe-state='.length);if(!value)throw new Error('NATIVE_PROBE_STATE_REQUIRED');
  stateDirectory=realpathSync(value);const prefix=kind==='restart'?'desktop-native-code-':'desktop-owner-smoke-';
  if(dirname(stateDirectory)!==realpathSync(local)||!basename(stateDirectory).startsWith(prefix))throw new Error('NATIVE_PROBE_STATE_REJECTED');
 }
 return{kind,stateDirectory,folderDirectory,dialogOpened:false,selectionMatched:false,readMethods:new Set()};
}
export function rejectedSecondary(probe:NativeProbe,lockHeld:boolean):void {
 writeFileSync(join(probe.stateDirectory,'secondary-result.json'),JSON.stringify({lockRejected:!lockHeld,ledgerOpened:false,pid:process.pid})+'\n',{mode:0o600});
}
export async function runNativeProbe(root:string,probe:NativeProbe,app:App,window:BrowserWindow,host:{ledger:ExecutionLedger;verifier?:NodeVerification;execution:ForegroundExecution;ownerEpoch:number}):Promise<void>{
 const output=(name:string,result:Record<string,unknown>)=>{const evidence={...result,observedAt:new Date().toISOString(),platform:process.platform+'-'+process.arch,cliVersion:verifiedCodex(root).lock.cliVersion,electronVersion:process.versions.electron,nodeVersion:process.versions.node,inferenceRequested:false};const file=join(root,`docs/progress/evidence/M1.4b-${name}.json`);writeFileSync(file,JSON.stringify(evidence,null,2)+'\n');writeFileSync(file.replace('.json',`-${evidence.observedAt.replaceAll(':','-').replaceAll('.','-')}.json`),JSON.stringify(evidence,null,2)+'\n');};
 if(probe.kind==='owner-primary'){
  writeFileSync(join(probe.stateDirectory,'owner-ready.json'),JSON.stringify({pid:process.pid,ownerEpoch:host.ownerEpoch,windowLoaded:true})+'\n',{mode:0o600});
  const deadline=Date.now()+45000,timer=setInterval(()=>{if(existsSync(join(probe.stateDirectory,'close-owner'))||Date.now()>deadline){clearInterval(timer);app.quit();}},100);timer.unref();return;
 }
 if(probe.kind==='folder'){
  const result=await window.webContents.executeJavaScript(`(async()=>{
   const wait=async check=>{const deadline=Date.now()+110000;while(!check()){if(Date.now()>deadline)throw new Error('NATIVE_FOLDER_TIMEOUT');await new Promise(r=>setTimeout(r,100));}};
   document.querySelector('[data-action="choose-project"]').click();await wait(()=>document.querySelector('[data-execution-panel]'));await wait(()=>!document.querySelector('[data-action="choose-project"]').disabled);
   const state=await window.personalAgent.workspaceState();return{projects:state.value.projects.length,selectedName:state.value.projects[0]?.name,sandboxed:window.personalAgent.security.sandboxed,isolated:window.personalAgent.security.isolated,hasRequire:typeof require!=='undefined'};
  })()`);
  const passed=probe.dialogOpened&&probe.selectionMatched&&result.projects===1&&result.selectedName===basename(probe.folderDirectory!)&&result.sandboxed===true&&result.isolated===true&&result.hasRequire===false;
  output('native-folder',{status:passed?'passed':'blocked',kind:'real_native_open_panel_selection',selection:'actual_native_dialog_via_computer_use',dialogOpened:probe.dialogOpened,selectionMatched:probe.selectionMatched,result});
  writeFileSync(join(root,'.local/M1-native-folder.png'),(await window.webContents.capturePage()).toPNG());app.quit();return;
 }
 if(probe.kind==='restart'){
  const original=JSON.parse(readFileSync(join(root,'docs/progress/evidence/M1-native-code-desktop.json'),'utf8'));
  if(original.status!=='passed'||!host.verifier)throw new Error('NATIVE_CODE_RECEIPT_REQUIRED');
  const expected=original.result,run=host.ledger.runForHost(expected.runId),receipt=host.verifier.result(run.workspaceId,run.runId);
  if(run.status!=='completed'||run.taskStatus!=='completed'||receipt?.status!=='passed'||receipt.workspaceHash!==hashInput(workspaceFiles(host.ledger.workspace(run.workspaceId).directory)))throw new Error('RESTART_VERIFICATION_CHANGED');
  const result=await window.webContents.executeJavaScript(`(async()=>{
   const wait=async check=>{const deadline=Date.now()+30000;while(!check()){if(Date.now()>deadline)throw new Error('RESTART_HISTORY_UI_TIMEOUT');await new Promise(r=>setTimeout(r,100));}};
   await wait(()=>document.querySelector('[data-task-status="completed"]'));
   const state=await window.personalAgent.workspaceState(),projectId=state.value.projects[0].id,rows=(await window.personalAgent.listRuns({projectId})).value;
   const cached=(await window.personalAgent.getRun({projectId,runId:${JSON.stringify(run.runId)}})).value;
   const review=(await window.personalAgent.getVerification({projectId,runId:cached.runId})).value;
   document.querySelector('[data-action="refresh-threads"]').click();await wait(()=>document.querySelector('[data-thread-id="'+${JSON.stringify(run.threadId)}+'"]'));
   document.querySelector('[data-thread-id="'+${JSON.stringify(run.threadId)}+'"]').click();await wait(()=>document.querySelector('[data-turn-id="'+${JSON.stringify(run.turnId)}+'"]'));
   document.querySelector('[data-turn-id="'+${JSON.stringify(run.turnId)}+'"]').click();await wait(()=>document.querySelector('[data-item-id]'));
   return{projectRestored:state.value.projects.length===1,runCount:rows.length,runId:cached.runId,threadId:cached.threadId,turnId:cached.turnId,taskStatus:cached.taskStatus,cachedItemCount:cached.snapshot?.items.length??0,
    receiptStatus:review.receipt?.status,executed:review.receipt?.executed,nativeHistoryItems:document.querySelectorAll('[data-item-id]').length,sandboxed:window.personalAgent.security.sandboxed,isolated:window.personalAgent.security.isolated,hasRequire:typeof require!=='undefined'};
  })()`);
  const methods=[...probe.readMethods].sort(),passed=result.projectRestored===true&&result.runId===run.runId&&result.threadId===run.threadId&&result.turnId===run.turnId&&result.taskStatus==='completed'&&result.receiptStatus==='passed'&&result.executed===4&&result.cachedItemCount>0&&result.nativeHistoryItems>0&&host.execution.diagnostics.clientTurnStarts===0&&JSON.stringify(methods)===JSON.stringify(['thread/items/list','thread/list','thread/read','thread/turns/list'])&&result.sandboxed===true&&result.isolated===true&&result.hasRequire===false;
  output('native-restart',{status:passed?'passed':'blocked',kind:'real_electron_restart_verified_code_and_native_history',receiptHashVerified:true,currentWorkspaceMatchesReceipt:true,ownerEpoch:host.ownerEpoch,verifiedMethods:methods,result,diagnostics:host.execution.diagnostics});
  writeFileSync(join(root,'.local/M1-native-restart.png'),(await window.webContents.capturePage()).toPNG());app.quit();
 }
}
