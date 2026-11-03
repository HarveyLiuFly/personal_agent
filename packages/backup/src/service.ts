import {createHash} from 'node:crypto';
import {constants,openSync,closeSync,readSync,writeSync,fstatSync,lstatSync,realpathSync,mkdirSync,readdirSync,writeFileSync,fsyncSync,renameSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {ExecutionLedger,LedgerError} from '../../store/src/ledger.ts';
import type {BackupCommand,BackupCommandResult,BackupPage,BackupVerification,BackupView} from '../../contracts/src/backups.ts';
import {RehearsalService} from './rehearsal.ts';

const idPattern=/^[a-f0-9]{64}$/,receiptPattern=/^[a-f0-9-]{36}\.json$/,hashPattern=/^[a-f0-9]{64}$/;
const maxDatabase=128*1024*1024,maxReceipt=1024*1024,maxTotalReceipts=64*1024*1024;
const digest=(data:string|Buffer)=>createHash('sha256').update(data).digest('hex');
function fail(code:string):never{throw new LedgerError(code);}
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const keys=(v:Record<string,unknown>,expected:string[])=>Object.keys(v).length===expected.length&&expected.every(k=>Object.hasOwn(v,k));
interface FileRecord {key:string;bytes:number;sha256:string}
interface Metadata {schemaRevision:number;runtimeEpoch:number;policyEpoch:number;privacyEpoch:number;tombstones:number;deletedThroughMs:number;activeRuns:number;pendingTerminals:number;pendingWorktreeOperations:number;profileId:string;dotId:string}
interface Manifest {format:1;backupId:string;createdAt:number;scope:'ledger_and_verification_receipts';metadata:Metadata;files:FileRecord[]}
interface Artifact {key:string;bytes:number;sha256:string}
/** Open one bounded regular file with no symlink following, preserving its identity through reads. */
export function backupFile(path:string,maximum:number,content=false,copyTo?:string):{bytes:number;sha256:string;content:Buffer}{
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  let output:number|undefined;
  try{
    const before=fstatSync(fd);if(!before.isFile()||before.size>maximum||before.size<1)fail('BACKUP_FILE_INVALID');
    if(copyTo)output=openSync(copyTo,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    const hash=createHash('sha256'),chunks:Buffer[]=[];let total=0;const buffer=Buffer.alloc(65536);
    while(true){const n=readSync(fd,buffer,0,Math.min(buffer.length,maximum-total+1),null);if(!n)break;total+=n;if(total>maximum)fail('BACKUP_FILE_TOO_LARGE');hash.update(buffer.subarray(0,n));if(content)chunks.push(Buffer.from(buffer.subarray(0,n)));if(output!==undefined){let offset=0;while(offset<n){const written=writeSync(output,buffer,offset,n-offset);if(written<=0)fail('BACKUP_COPY_FAILED');offset+=written;}}}
    const after=fstatSync(fd),current=lstatSync(path);if(after.size!==total||before.size!==after.size||before.mtimeMs!==after.mtimeMs||current.isSymbolicLink()||current.dev!==after.dev||current.ino!==after.ino)fail('BACKUP_FILE_CHANGED');
    if(output!==undefined)fsyncSync(output);return{bytes:total,sha256:hash.digest('hex'),content:content?Buffer.concat(chunks):Buffer.alloc(0)};
  }finally{if(output!==undefined)closeSync(output);closeSync(fd);}
}
export function backupSync(path:string){const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);try{const info=fstatSync(fd);if(!info.isFile()&&!info.isDirectory())fail('BACKUP_FILE_INVALID');fsyncSync(fd);}finally{closeSync(fd);}}
export function backupDirectory(path:string):string{const info=lstatSync(path);if(!info.isDirectory()||info.isSymbolicLink()||realpathSync(path)!==path||(info.mode&0o077)!==0)fail('BACKUP_DIRECTORY_CHANGED');return info.dev+':'+info.ino;}
const file=backupFile,sync=backupSync,directory=backupDirectory;
/** Reads ONLY the fixed schema from a newly created or hash-checked local snapshot. */
function inspect(database:string):{metadata:Metadata;artifacts:Artifact[]}{
  const db=new DatabaseSync(database,{readOnly:true});
  try{
    db.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON; PRAGMA foreign_keys=ON;');
    if(db.prepare('PRAGMA quick_check').get()?.quick_check!=='ok'||db.prepare('PRAGMA foreign_key_check').all().length)fail('BACKUP_DATABASE_INVALID');
    if(db.prepare('SELECT schema_revision FROM schema_metadata WHERE singleton=1').get()?.schema_revision!==6)fail('BACKUP_SCHEMA_UNSUPPORTED');
    if(db.prepare('SELECT count(*) AS n FROM profiles').get()?.n!==1||db.prepare('SELECT count(*) AS n FROM dots').get()?.n!==1)fail('BACKUP_PROFILE_UNSUPPORTED');
    const row=db.prepare('SELECT d.dot_id,d.profile_id,d.policy_epoch,d.privacy_epoch,o.runtime_epoch FROM dots d JOIN runtime_owners o USING(profile_id)').get();
    if(!row||row.dot_id!=='local-dot'||row.profile_id!=='local-profile')fail('BACKUP_PROFILE_UNSUPPORTED');
    const count=(sql:string)=>Number(db.prepare(sql).get()!.n);
    const metadata:Metadata={schemaRevision:6,profileId:String(row.profile_id),dotId:String(row.dot_id),runtimeEpoch:Number(row.runtime_epoch),policyEpoch:Number(row.policy_epoch),privacyEpoch:Number(row.privacy_epoch),tombstones:count('SELECT count(*) AS n FROM privacy_tombstones'),deletedThroughMs:count('SELECT coalesce(max(deleted_at_ms),0) AS n FROM privacy_tombstones'),activeRuns:count("SELECT count(*) AS n FROM task_runs WHERE status IN ('preparing','submitting','running','waiting_input','waiting_approval','outcome_unknown')"),pendingTerminals:count("SELECT count(*) AS n FROM terminal_sessions WHERE state<>'exited'"),pendingWorktreeOperations:count("SELECT count(*) AS n FROM worktree_operations WHERE state IN ('prepared','dispatching','outcome_unknown')")};
    const rows=db.prepare("SELECT a.*,EXISTS(SELECT 1 FROM verification_results v WHERE v.evidence_ref=a.artifact_id) AS is_receipt FROM artifacts a WHERE a.state='published' LIMIT 513").all();
    if(rows.length>512)fail('BACKUP_ARTIFACT_LIMIT');
    const artifacts=rows.map(a=>{if(a.is_receipt!==1||!receiptPattern.test(String(a.relative_storage_key))||!hashPattern.test(String(a.content_sha256))||!Number.isSafeInteger(a.size_bytes)||Number(a.size_bytes)<1||Number(a.size_bytes)>maxReceipt)fail('BACKUP_ARTIFACT_UNSUPPORTED');return{key:String(a.relative_storage_key),bytes:Number(a.size_bytes),sha256:String(a.content_sha256)};}).sort((a,b)=>a.key.localeCompare(b.key));
    if(new Set(artifacts.map(a=>a.key)).size!==artifacts.length||artifacts.reduce((n,a)=>n+a.bytes,0)>maxTotalReceipts)fail('BACKUP_ARTIFACT_LIMIT');
    return{metadata,artifacts};
  }finally{db.close();}
}
export interface BackupOptions {directory:string;verificationDirectory:string;/** Trusted crash tests only; not IPC. */afterStage?:(stage:'snapshot'|'published')=>void;afterRehearsalStage?:(stage:'copied'|'published')=>void}
/** Private snapshots only. This service NEVER opens a snapshot as an execution Owner or restores it. */
export class BackupService {
  private store:ExecutionLedger;private options:BackupOptions;private root:string;private rootIdentity:string;private rehearsals:RehearsalService;
  constructor(store:ExecutionLedger,options:BackupOptions){this.store=store;this.options=options;this.root=resolve(options.directory);mkdirSync(this.root,{recursive:true,mode:0o700});this.rootIdentity=directory(this.root);this.rehearsals=new RehearsalService({directory:join(this.root,'..','rehearsals'),watermarks:()=>store.recoveryWatermarks(),copy:(id,destination)=>this.copyForRehearsal(id,destination),files:{read:backupFile,sync:backupSync,directory:backupDirectory},afterStage:options.afterRehearsalStage});}
  private anchor(){if(directory(this.root)!==this.rootIdentity)fail('BACKUP_DIRECTORY_CHANGED');}
  private manifest(path:string,id:string):Manifest{
    const value:unknown=JSON.parse(file(join(path,'manifest.json'),262144,true).content.toString('utf8'));
    if(!object(value)||!keys(value,['format','backupId','createdAt','scope','metadata','files'])||value.format!==1||value.backupId!==id||value.scope!=='ledger_and_verification_receipts'||!Number.isSafeInteger(value.createdAt)||Number(value.createdAt)<1||!object(value.metadata)||value.metadata.schemaRevision!==6||!Array.isArray(value.files)||value.files.length<1||value.files.length>513)fail('BACKUP_MANIFEST_INVALID');
    const names=new Set<string>();for(const entry of value.files){if(!object(entry)||!keys(entry,['key','bytes','sha256'])||typeof entry.key!=='string'||!(entry.key==='ledger.db'||(entry.key.startsWith('receipts/')&&receiptPattern.test(entry.key.slice(9))))||names.has(entry.key)||!hashPattern.test(String(entry.sha256))||!Number.isSafeInteger(entry.bytes)||Number(entry.bytes)<1||Number(entry.bytes)>(entry.key==='ledger.db'?maxDatabase:maxReceipt))fail('BACKUP_MANIFEST_INVALID');names.add(entry.key);}
    if(!names.has('ledger.db')||value.files.filter(e=>e.key!=='ledger.db').reduce((n,e)=>n+e.bytes,0)>maxTotalReceipts)fail('BACKUP_MANIFEST_INVALID');return value as unknown as Manifest;
  }
  list():BackupPage{
    try{this.anchor();const entries=readdirSync(this.root);if(entries.length>200)fail('BACKUP_DIRECTORY_LIMIT');const ids=[...new Set(entries.filter(e=>idPattern.test(e)||/^[a-f0-9]{64}\.pending$/.test(e)).map(e=>e.slice(0,64)))];if(ids.length>20)fail('BACKUP_COUNT_LIMIT');
      const items:BackupView[]=ids.map(id=>{try{directory(join(this.root,id));const m=this.manifest(join(this.root,id),id);return{id,state:'available',createdAt:m.createdAt,bytes:m.files.reduce((n,f)=>n+f.bytes,0),receipts:m.files.length-1,schemaRevision:m.metadata.schemaRevision};}catch{let state:BackupView['state']='invalid';try{directory(join(this.root,id+'.pending'));if(!entries.includes(id))state='incomplete';}catch{}return{id,state,createdAt:null,bytes:null,receipts:null,schemaRevision:null};}});
      return{items:items.sort((a,b)=>(b.createdAt??0)-(a.createdAt??0)||a.id.localeCompare(b.id)),limit:20,scope:'ledger_and_verification_receipts',rehearsals:this.rehearsals.list()};
    }catch(error){throw error instanceof LedgerError?error:new LedgerError('BACKUP_READ_FAILED');}
  }
  command(input:Exclude<BackupCommand,{kind:'prepareRestore'|'activateRestore'}>):BackupCommandResult{
    const key=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<=200&&!/[\x00-\x1f]/.test(v);
    if(!object(input)||!((input.kind==='create'&&keys(input,['kind','commandKey'])&&key(input.commandKey))||(input.kind==='verify'&&keys(input,['kind','backupId'])&&typeof input.backupId==='string'&&idPattern.test(input.backupId))||(input.kind==='rehearse'&&keys(input,['kind','backupId','commandKey'])&&typeof input.backupId==='string'&&idPattern.test(input.backupId)&&key(input.commandKey))))fail('INVALID_BACKUP_COMMAND');
    try{
      this.anchor();const id=input.kind==='create'?digest(input.commandKey):input.backupId;
      if(input.kind==='rehearse')return{...this.checked(id),rehearsal:this.rehearsals.create(id,input.commandKey)};
      if(input.kind==='create'){
        const page=this.list(),existing=page.items.find(b=>b.id===id);if(existing){if(existing.state!=='available')fail('BACKUP_INCOMPLETE_OR_INVALID');return this.checked(id);}
        if(page.items.length>=20)fail('BACKUP_COUNT_LIMIT');
        const stage=join(this.root,id+'.pending');mkdirSync(stage,{mode:0o700});const stageIdentity=directory(stage),database=join(stage,'ledger.db');this.store.snapshotForBackup(database);this.options.afterStage?.('snapshot');
        const {metadata,artifacts}=inspect(database),databaseFile=file(database,maxDatabase);mkdirSync(join(stage,'receipts'),{mode:0o700});
        const files:FileRecord[]=[{key:'ledger.db',bytes:databaseFile.bytes,sha256:databaseFile.sha256}];
        for(const artifact of artifacts){
          const source=file(join(resolve(this.options.verificationDirectory),artifact.key),maxReceipt,true);if(source.bytes!==artifact.bytes||source.sha256!==artifact.sha256)fail('BACKUP_ARTIFACT_CHANGED');
          const key='receipts/'+artifact.key;writeFileSync(join(stage,key),source.content,{flag:'wx',mode:0o600});sync(join(stage,key));files.push({key,bytes:source.bytes,sha256:source.sha256});
        }
        const manifest:Manifest={format:1,backupId:id,createdAt:Date.now(),scope:'ledger_and_verification_receipts',metadata,files};sync(database);sync(join(stage,'receipts'));writeFileSync(join(stage,'manifest.json'),JSON.stringify(manifest)+'\n',{flag:'wx',mode:0o600});sync(join(stage,'manifest.json'));sync(stage);this.anchor();if(directory(stage)!==stageIdentity)fail('BACKUP_DIRECTORY_CHANGED');
        try{lstatSync(join(this.root,id));fail('BACKUP_TARGET_EXISTS');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
        renameSync(stage,join(this.root,id));sync(this.root);this.options.afterStage?.('published');
      }
      return this.checked(id);
    }catch(error){throw error instanceof LedgerError?error:new LedgerError('BACKUP_OPERATION_FAILED');}
  }
  private checked(id:string):BackupCommandResult{
    this.anchor();const path=join(this.root,id),identity=directory(path),m=this.manifest(path,id);directory(join(path,'receipts'));
    const expected=['ledger.db','manifest.json','receipts'].sort(),actual=readdirSync(path).sort();if(JSON.stringify(actual)!==JSON.stringify(expected)||JSON.stringify(readdirSync(join(path,'receipts')).sort())!==JSON.stringify(m.files.filter(f=>f.key.startsWith('receipts/')).map(f=>f.key.slice(9)).sort()))fail('BACKUP_FILES_MISMATCH');
    for(const entry of m.files){const check=file(join(path,entry.key),entry.key==='ledger.db'?maxDatabase:maxReceipt);if(check.bytes!==entry.bytes||check.sha256!==entry.sha256)fail('BACKUP_HASH_MISMATCH');}
    const {metadata,artifacts}=inspect(join(path,'ledger.db'));if(JSON.stringify(metadata)!==JSON.stringify(m.metadata)||JSON.stringify(artifacts.map(a=>({key:'receipts/'+a.key,bytes:a.bytes,sha256:a.sha256})))!==JSON.stringify(m.files.filter(f=>f.key!=='ledger.db')))fail('BACKUP_REFERENCES_MISMATCH');
    const last=file(join(path,'ledger.db'),maxDatabase);if(last.sha256!==m.files.find(f=>f.key==='ledger.db')!.sha256||directory(path)!==identity)fail('BACKUP_FILE_CHANGED');this.anchor();
    const bytes=m.files.reduce((n,f)=>n+f.bytes,0),verification:BackupVerification={id,verifiedAt:Date.now(),files:m.files.length,bytes,schemaRevision:metadata.schemaRevision,activeRuns:metadata.activeRuns,pendingTerminals:metadata.pendingTerminals,pendingWorktreeOperations:metadata.pendingWorktreeOperations,runtimeEpoch:metadata.runtimeEpoch,policyEpoch:metadata.policyEpoch,privacyEpoch:metadata.privacyEpoch,tombstones:metadata.tombstones};
    return{backup:{id,state:'available',createdAt:m.createdAt,bytes,receipts:m.files.length-1,schemaRevision:metadata.schemaRevision},verification};
  }
  /** Host-only new private copy; no Renderer-selected destination is accepted. */
  copyForRestore(id:string,destination:string):void{this.copyForRehearsal(id,destination);}
  private copyForRehearsal(id:string,destination:string):void{
    this.checked(id);directory(destination);const source=join(this.root,id),identity=directory(source),manifest=this.manifest(source,id);mkdirSync(join(destination,'receipts'),{mode:0o700});
    for(const entry of manifest.files){const copied=file(join(source,entry.key),entry.key==='ledger.db'?maxDatabase:maxReceipt,false,join(destination,entry.key));if(copied.bytes!==entry.bytes||copied.sha256!==entry.sha256)fail('BACKUP_HASH_MISMATCH');}
    if(directory(source)!==identity)fail('BACKUP_DIRECTORY_CHANGED');this.anchor();sync(join(destination,'receipts'));sync(destination);
  }
}
