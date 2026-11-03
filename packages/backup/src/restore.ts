import {createHash} from 'node:crypto';
import {existsSync,lstatSync,mkdirSync,readdirSync,renameSync,rmSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {ExecutionLedger,LedgerError} from '../../store/src/ledger.ts';
import {BackupService,backupDirectory,backupFile,backupSync} from './service.ts';
import {prepareRestoreDatabase} from './restore-database.ts';
import type {RestoreView} from '../../contracts/src/backups.ts';
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const valid=(id:unknown):id is string=>typeof id==='string'&&/^[a-f0-9]{64}$/.test(id);
function fail(code:string):never{throw new LedgerError(code);}
function absent(path:string):boolean{try{lstatSync(path);return false;}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return true;throw e;}}
const exact=(value:unknown,keys:string[]):value is Record<string,unknown>=>Boolean(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(k=>Object.hasOwn(value,k)));
interface Prepared {format:1;id:string;backupId:string;safetyBackupId:string;createdAt:number;stateStamp:string;summary:ReturnType<typeof prepareRestoreDatabase>;files:Array<{key:string;sha256:string;bytes:number}>}
/** A missing or invalid committed pointer never falls back to an older runtime. */
export function activeRuntimePaths(storageRoot:string,legacyVerification=join(storageRoot,'verification')):{database:string;verification:string;generation:string|null}{
 const root=resolve(storageRoot),directory=join(root,'runtimes'),pointer=join(directory,'active.json');
 if(absent(pointer)){if(!absent(join(directory,'ACTIVATION_REQUIRED')))fail('RESTORE_ACTIVE_POINTER_MISSING');return{database:join(root,'execution/ledger.db'),verification:legacyVerification,generation:null};}
 backupDirectory(directory);const data:unknown=JSON.parse(backupFile(pointer,1024,true).content.toString());
 if(!exact(data,['format','id'])||data.format!==1||!valid(data.id))fail('RESTORE_ACTIVE_POINTER_INVALID');
 const path=join(directory,data.id);backupDirectory(path);
 if(!absent(join(path,'RESTORE_QUARANTINE')))fail('RESTORE_ACTIVATION_INCOMPLETE');
 const activation:unknown=JSON.parse(backupFile(join(path,'ACTIVATED.json'),2048,true).content.toString());
 if(!exact(activation,['format','id','activatedAt'])||activation.format!==1||activation.id!==data.id||!Number.isSafeInteger(activation.activatedAt))fail('RESTORE_ACTIVATION_INVALID');
 backupFile(join(path,'ledger.db'),128*1024*1024);backupDirectory(join(path,'artifacts'));
 return{database:join(path,'ledger.db'),verification:path,generation:data.id};
}
/** Cold, idle-only generation activation. The caller holds the OS lock and stops the old Owner first. */
export class RestoreService {
 private store:ExecutionLedger;private backups:BackupService;private root:string;private identity:string;private sourceDatabase:string;
 private afterStage?: (stage:'prepared'|'before_pointer'|'commit_intent'|'activated')=>void;
 constructor(store:ExecutionLedger,backups:BackupService,storageRoot:string,afterStage?:(stage:'prepared'|'before_pointer'|'commit_intent'|'activated')=>void){this.store=store;this.backups=backups;const current=activeRuntimePaths(storageRoot);this.sourceDatabase=current.database;this.root=resolve(storageRoot,'runtimes');mkdirSync(this.root,{recursive:true,mode:0o700});this.identity=backupDirectory(this.root);this.afterStage=afterStage;if(current.generation)this.requirePointer();}
 private requirePointer(){const marker=join(this.root,'ACTIVATION_REQUIRED');if(absent(marker)){writeFileSync(marker,'Committed runtime generation requires an active pointer.\n',{flag:'wx',mode:0o600});backupSync(marker);backupSync(this.root);}else backupFile(marker,1024);}
 private anchor(){if(backupDirectory(this.root)!==this.identity)fail('RESTORE_DIRECTORY_CHANGED');}
 private read(id:string,checkFiles=true):Prepared {
  this.anchor();if(!valid(id))fail('INVALID_RESTORE_ID');const path=join(this.root,id);backupDirectory(path);
  const r:unknown=JSON.parse(backupFile(join(path,'restore.json'),262144,true).content.toString());
  if(!exact(r,['format','id','backupId','safetyBackupId','createdAt','stateStamp','summary','files'])||r.format!==1||r.id!==id||!valid(r.backupId)||!valid(r.safetyBackupId)||!valid(r.stateStamp)||!Number.isSafeInteger(r.createdAt)||!Array.isArray(r.files)||r.files.length<2||r.files.length>514)fail('RESTORE_REPORT_INVALID');
  const seen=new Set<string>();for(const f of r.files){if(!exact(f,['key','sha256','bytes'])||typeof f.key!=='string'||!(f.key==='ledger.db'||f.key==='current.db'||/^artifacts\/[a-f0-9-]{36}\.json$/.test(f.key))||seen.has(f.key)||!valid(f.sha256)||!Number.isSafeInteger(f.bytes)||Number(f.bytes)<1)fail('RESTORE_REPORT_INVALID');seen.add(f.key);if(checkFiles){const actual=backupFile(join(path,f.key),f.key.endsWith('.db')?128*1024*1024:1024*1024);if(actual.bytes!==f.bytes||actual.sha256!==f.sha256)fail('RESTORE_COPY_CHANGED');}}
  const summaryKeys=['runtimeEpoch','policyEpoch','privacyEpoch','tombstones','unknownRuns','pausedSchedules','revokedApprovals','retainedLeases','quarantinedArtifacts','mergedBudgetBuckets'];
  const summary=r.summary;
  if(!seen.has('ledger.db')||!seen.has('current.db')||!exact(summary,summaryKeys)||summaryKeys.some(k=>!Number.isSafeInteger(summary[k])||Number(summary[k])<0))fail('RESTORE_REPORT_INVALID');
  if(checkFiles){
   const expected=['ledger.db','current.db','artifacts','restore.json',...(!absent(join(path,'RESTORE_QUARANTINE'))?['RESTORE_QUARANTINE']:[]),...(!absent(join(path,'ACTIVATED.json'))?['ACTIVATED.json']:[])].sort();
   if(JSON.stringify(readdirSync(path).sort())!==JSON.stringify(expected)||JSON.stringify(readdirSync(join(path,'artifacts')).sort())!==JSON.stringify([...seen].filter(k=>k.startsWith('artifacts/')).map(k=>k.slice(10)).sort()))fail('RESTORE_FILES_MISMATCH');
  }
  return r as unknown as Prepared;
 }
 private view(r:Prepared,state:RestoreView['state']):RestoreView{return{id:r.id,backupId:r.backupId,safetyBackupId:r.safetyBackupId,createdAt:r.createdAt,state,summary:r.summary};}
 list():RestoreView[]{this.anchor();const names=readdirSync(this.root);if(names.length>100)fail('RESTORE_DIRECTORY_LIMIT');const active=(()=>{try{const p=JSON.parse(backupFile(join(this.root,'active.json'),1024,true).content.toString());return p.id;}catch{return null;}})();return names.filter(valid).map(id=>{try{const r=this.read(id,id!==active);return this.view(r,id===active?'active':r.stateStamp===this.store.recoveryStateStamp()?'prepared':'expired');}catch{return{id,backupId:null,safetyBackupId:null,createdAt:null,state:'invalid' as const,summary:null};}}).sort((a,b)=>(b.createdAt??0)-(a.createdAt??0));}
 prepare(input:unknown):RestoreView {
  if(!exact(input,['kind','backupId','commandKey'])||input.kind!=='prepareRestore'||!valid(input.backupId)||typeof input.commandKey!=='string'||!input.commandKey||input.commandKey.length>200||/[\x00-\x1f]/.test(input.commandKey))fail('INVALID_RESTORE_COMMAND');
  this.anchor();const id=digest(['restore',input.commandKey]),target=join(this.root,id),stage=target+'.pending';
  if(!absent(target)){const r=this.read(id);if(r.backupId!==input.backupId)fail('IDEMPOTENCY_CONFLICT');return this.view(r,r.stateStamp===this.store.recoveryStateStamp()?'prepared':'expired');}
  if(!absent(stage))fail('RESTORE_INCOMPLETE');if(readdirSync(this.root).filter(n=>valid(n)||/^[a-f0-9]{64}\.pending$/.test(n)).length>=20)fail('RESTORE_COUNT_LIMIT');
  // A full pre-switch backup preserves published current receipts as well as the current DB.
  const safety=this.backups.command({kind:'create',commandKey:'pre-restore:'+input.commandKey});
  mkdirSync(stage,{mode:0o700});const stageIdentity=backupDirectory(stage);writeFileSync(join(stage,'RESTORE_QUARANTINE'),id,{flag:'wx',mode:0o600});backupSync(join(stage,'RESTORE_QUARANTINE'));backupSync(stage);
  this.store.snapshotForBackup(join(stage,'current.db'));this.backups.copyForRestore(input.backupId,stage);renameSync(join(stage,'receipts'),join(stage,'artifacts'));
  const summary=prepareRestoreDatabase(join(stage,'ledger.db'),join(stage,'current.db'),id),files:Prepared['files']=[];
  const candidate=new DatabaseSync(join(stage,'ledger.db'),{readOnly:true});let kept:Set<string>;try{kept=new Set(candidate.prepare("SELECT relative_storage_key FROM artifacts WHERE state='published'").all().map(r=>String(r.relative_storage_key)));}finally{candidate.close();}
  for(const name of readdirSync(join(stage,'artifacts'))){if(!/^[a-f0-9-]{36}\.json$/.test(name))fail('RESTORE_ARTIFACT_INVALID');if(!kept.has(name))rmSync(join(stage,'artifacts',name));}
  for(const key of ['ledger.db','current.db',...readdirSync(join(stage,'artifacts')).sort().map(n=>'artifacts/'+n)]){const info=backupFile(join(stage,key),key.endsWith('.db')?128*1024*1024:1024*1024);files.push({key,bytes:info.bytes,sha256:info.sha256});backupSync(join(stage,key));}
  const r:Prepared={format:1,id,backupId:input.backupId,safetyBackupId:safety.backup.id,createdAt:Date.now(),stateStamp:this.store.recoveryStateStamp(),summary,files};writeFileSync(join(stage,'restore.json'),JSON.stringify(r)+'\n',{flag:'wx',mode:0o600});backupSync(join(stage,'restore.json'));backupSync(join(stage,'artifacts'));backupSync(stage);this.anchor();if(backupDirectory(stage)!==stageIdentity||!absent(target))fail('RESTORE_DIRECTORY_CHANGED');renameSync(stage,target);backupSync(this.root);this.afterStage?.('prepared');return this.view(r,'prepared');
 }
 /** Validate immediately before draining; no await may occur before the caller blocks all commands. */
 checkActivation(input:unknown):{id:string;view:RestoreView}{
  if(!exact(input,['kind','restoreId'])||input.kind!=='activateRestore'||!valid(input.restoreId))fail('INVALID_RESTORE_COMMAND');const r=this.read(input.restoreId);if(r.stateStamp!==this.store.recoveryStateStamp())fail('RESTORE_CURRENT_STATE_CHANGED');if(absent(join(this.root,r.id,'RESTORE_QUARANTINE')))fail('RESTORE_ALREADY_ACTIVATED');return{id:r.id,view:this.view(r,'prepared')};
 }
 /** Caller has closed the old services and Ledger. This never deletes either runtime generation. */
 activateAfterOwnerStopped(id:string):void{
  const r=this.read(id),path=join(this.root,id);const stopped=backupFile(join(path,'ledger.db'),128*1024*1024);if(stopped.sha256!==r.files.find(f=>f.key==='ledger.db')!.sha256)fail('RESTORE_COPY_CHANGED');
  const source=new DatabaseSync(this.sourceDatabase,{readOnly:true}),snapshot=new DatabaseSync(join(path,'current.db'),{readOnly:true});try{const current=source.prepare('SELECT * FROM runtime_owners').get(),prior=snapshot.prepare('SELECT * FROM runtime_owners').get();if(!current||!prior||current.state!=='stopped'||current.runtime_epoch!==prior.runtime_epoch||current.instance_id!==prior.instance_id)fail('RESTORE_OWNER_NOT_STOPPED');}finally{source.close();snapshot.close();}
  writeFileSync(join(path,'ACTIVATED.json'),JSON.stringify({format:1,id,activatedAt:Date.now()})+'\n',{flag:'wx',mode:0o600});backupSync(join(path,'ACTIVATED.json'));rmSync(join(path,'RESTORE_QUARANTINE'));backupSync(path);this.afterStage?.('before_pointer');
  this.requirePointer();this.afterStage?.('commit_intent');
  const pending=join(this.root,'active-'+id+'.pending');writeFileSync(pending,JSON.stringify({format:1,id})+'\n',{flag:'wx',mode:0o600});backupSync(pending);this.anchor();renameSync(pending,join(this.root,'active.json'));backupSync(this.root);this.afterStage?.('activated');
 }
}
