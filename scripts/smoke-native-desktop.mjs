import {spawn} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import electron from 'electron';
import {openDisplay} from './virtual-display.mjs';
const root=resolve(import.meta.dirname,'..'),owner=process.argv.includes('--owner'),folder=process.argv.includes('--folder'),workspace=process.argv.includes('--workspace');
const name=workspace?'workspace':owner?'owner':folder?'native-folder':'native-restart',file=join(root,`docs/progress/evidence/${workspace?'M2.1a-desktop':'M1.4b-'+name}.json`);
await mkdir(join(root,'.local'),{recursive:true});await writeFile(file,JSON.stringify({status:'running',observedAt:new Date().toISOString()})+'\n');
let display,evidence;const children=[];
const sleep=ms=>new Promise(done=>setTimeout(done,ms));
function launch(flag,state){
 const child=spawn(electron,['.',flag,...(state?[`--probe-state=${state}`]:[])],{cwd:root,env:display.env,stdio:['ignore','ignore','pipe']});child.stderr.on('data',()=>{});
 const info={child,ended:false,exit:new Promise(done=>{child.once('error',()=>{info.ended=true;done({exitCode:null,error:'ELECTRON_SPAWN_FAILED'});});child.once('close',(exitCode,signal)=>{info.ended=true;done({exitCode,signal});});})};children.push(info);return info;
}
async function bounded(promise,ms){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('ELECTRON_PROBE_TIMEOUT')),ms);})]);}finally{clearTimeout(timer);}}
async function ready(state,info){const deadline=Date.now()+15000;while(Date.now()<deadline){try{return JSON.parse(await readFile(join(state,'owner-ready.json'),'utf8'));}catch{}if(info.ended)throw new Error('OWNER_EXITED_BEFORE_READY');await sleep(100);}throw new Error('OWNER_STARTUP_TIMEOUT');}
function database(state){const db=new DatabaseSync(join(state,'execution/ledger.db'),{readOnly:true});try{return db.prepare('SELECT runtime_epoch,instance_id,state FROM runtime_owners').get();}finally{db.close();}}
async function closeOwner(state,info){await writeFile(join(state,'close-owner'),'close controlled acceptance process\n',{mode:0o600});const result=await bounded(info.exit,8000);if(result.exitCode!==0)throw new Error('OWNER_CLOSE_FAILED');}
try{
 display=await openDisplay(root);
 if(owner){
  const state=await mkdtemp(join(root,'.local/desktop-owner-smoke-')),first=launch('--m1-owner-primary',state),initial=await ready(state,first),before=database(state);
  const second=launch('--m1-owner-secondary',state),secondExit=await bounded(second.exit,12000),rejection=JSON.parse(await readFile(join(state,'secondary-result.json'),'utf8')),after=database(state);
  if(secondExit.exitCode!==0||rejection.lockRejected!==true||rejection.ledgerOpened!==false||before.runtime_epoch!==after.runtime_epoch||before.instance_id!==after.instance_id||after.state!=='ready'||initial.windowLoaded!==true)throw new Error('OS_SINGLE_INSTANCE_NOT_ENFORCED');
  await closeOwner(state,first);if(database(state).state!=='stopped')throw new Error('OWNER_NOT_CLOSED');await rm(join(state,'close-owner'));await rm(join(state,'owner-ready.json'));
  const third=launch('--m1-owner-primary',state),reopened=await ready(state,third),latest=database(state);if(reopened.ownerEpoch!==initial.ownerEpoch+1||latest.runtime_epoch!==before.runtime_epoch+1||latest.instance_id===before.instance_id)throw new Error('OWNER_RESTART_EPOCH_INVALID');await closeOwner(state,third);
  evidence={status:'passed',observedAt:new Date().toISOString(),kind:'real_electron_os_single_instance_and_owner_restart',platform:process.platform+'-'+process.arch,display:display.kind,inferenceRequested:false,firstWindowLoaded:true,secondProcessLockRejected:true,secondProcessOpenedLedger:false,epochWhileOwnerAlive:initial.ownerEpoch,epochAfterRejectedSecond:after.runtime_epoch,epochAfterNewOwner:reopened.ownerEpoch,finalOwnerState:database(state).state,processesLaunched:3};
 }else{
  const state=process.argv.find(arg=>arg.startsWith('--state='))?.slice('--state='.length);if(!folder&&!workspace&&!state)throw new Error('RESTART_STATE_REQUIRED');
  const child=launch(workspace?'--m2-workspace-smoke':folder?'--m1-native-folder-smoke':'--m1-native-restart-smoke',state),outcome=await bounded(child.exit,folder?120000:60000),result=JSON.parse(await readFile(file,'utf8'));
  evidence={...result,observedAt:new Date().toISOString(),display:display.kind,...outcome,platform:process.platform+'-'+process.arch,status:result.status==='passed'&&outcome.exitCode===0?'passed':'blocked'};
 }
}catch(error){evidence={status:'blocked',observedAt:new Date().toISOString(),kind:'real_electron_native_'+name,inferenceRequested:false,code:error instanceof Error&&/^[A-Z0-9_]+$/.test(error.message)?error.message:'HOST_ERROR'};}
finally{
 for(const info of children){if(!info.ended){info.child.kill('SIGTERM');try{await bounded(info.exit,1500);}catch{info.child.kill('SIGKILL');await bounded(info.exit,3000).catch(()=>{});}}}await display?.close();
}
await writeFile(file,JSON.stringify(evidence,null,2)+'\n');await writeFile(file.replace('.json',`-${evidence.observedAt.replaceAll(':','-').replaceAll('.','-')}.json`),JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify(evidence,null,2));if(evidence.status!=='passed')process.exitCode=1;
