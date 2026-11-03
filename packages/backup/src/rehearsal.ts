import {createHash} from 'node:crypto';
import {mkdirSync,readdirSync,writeFileSync,renameSync,lstatSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {ExecutionLedger,LedgerError} from '../../store/src/ledger.ts';
import type {RehearsalSummary,RehearsalView} from '../../contracts/src/backups.ts';
import {prepareRehearsalDatabase} from './rehearsal-database.ts';
import type {RehearsalWatermarks} from './rehearsal-database.ts';
const validId=(id:string)=>/^[a-f0-9]{64}$/.test(id),maxDatabase=128*1024*1024,maxReceipt=1024*1024;
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
function fail(code:string):never{throw new LedgerError(code);}
interface RecordFile {key:string;bytes:number;sha256:string}
interface Report {format:1;id:string;backupId:string;createdAt:number;currentWatermarkHash:string;summary:RehearsalSummary;files:RecordFile[]}
interface FileTools {read:(path:string,maximum:number,content?:boolean,copyTo?:string)=>{bytes:number;sha256:string;content:Buffer};sync:(path:string)=>void;directory:(path:string)=>string}
export interface RehearsalOptions {directory:string;copy:(backupId:string,destination:string)=>void;watermarks:()=>RehearsalWatermarks;files:FileTools;afterStage?:(stage:'copied'|'published')=>void}
/** Physically restores an isolated candidate. Its marker and database are rejected by the normal Owner. */
export class RehearsalService {
  private options:RehearsalOptions;private root:string;private identity:string;
  constructor(options:RehearsalOptions){this.options=options;this.root=resolve(options.directory);mkdirSync(this.root,{recursive:true,mode:0o700});this.identity=options.files.directory(this.root);}
  private anchor(){if(this.options.files.directory(this.root)!==this.identity)fail('REHEARSAL_DIRECTORY_CHANGED');}
  private report(path:string,id:string):Report{
    const r:unknown=JSON.parse(this.options.files.read(join(path,'report.json'),262144,true).content.toString('utf8'));
    if(!r||typeof r!=='object'||Array.isArray(r))fail('REHEARSAL_REPORT_INVALID');const v=r as Record<string,unknown>;
    if(v.format!==1||v.id!==id||typeof v.backupId!=='string'||!validId(v.backupId)||!Number.isSafeInteger(v.createdAt)||Number(v.createdAt)<1||typeof v.currentWatermarkHash!=='string'||!validId(v.currentWatermarkHash)||!Array.isArray(v.files)||v.files.length<2||v.files.length>514||!v.summary||typeof v.summary!=='object'||Array.isArray(v.summary))fail('REHEARSAL_REPORT_INVALID');
    const names=new Set<string>();for(const f of v.files){if(!f||typeof f!=='object'||typeof f.key!=='string'||!(f.key==='ledger.db'||f.key==='RESTORE_QUARANTINE'||/^receipts\/[a-f0-9-]{36}\.json$/.test(f.key))||names.has(f.key)||!Number.isSafeInteger(f.bytes)||f.bytes<1||f.bytes>(f.key==='ledger.db'?maxDatabase:maxReceipt)||typeof f.sha256!=='string'||!validId(f.sha256))fail('REHEARSAL_REPORT_INVALID');names.add(f.key);}
    if(!names.has('ledger.db')||!names.has('RESTORE_QUARANTINE')||v.files.filter(f=>f.key.startsWith('receipts/')).reduce((n,f)=>n+f.bytes,0)>64*1024*1024)fail('REHEARSAL_REPORT_INVALID');
    const summary=v.summary as Record<string,unknown>,fields=['runtimeEpoch','policyEpoch','privacyEpoch','tombstones','unknownRuns','pausedSchedules','revokedApprovals','retainedLeases','quarantinedArtifacts'];if(Object.keys(summary).length!==fields.length||fields.some(k=>!Number.isSafeInteger(summary[k])||Number(summary[k])<0))fail('REHEARSAL_REPORT_INVALID');
    return r as Report;
  }
  list():RehearsalView[]{
    this.anchor();const entries=readdirSync(this.root);if(entries.length>200)fail('REHEARSAL_DIRECTORY_LIMIT');const ids=[...new Set(entries.filter(e=>validId(e)||/^[a-f0-9]{64}\.pending$/.test(e)).map(e=>e.slice(0,64)))];if(ids.length>20)fail('REHEARSAL_COUNT_LIMIT');
    return ids.map(id=>{try{const path=join(this.root,id);this.options.files.directory(path);const r=this.report(path,id);this.options.files.read(join(path,'RESTORE_QUARANTINE'),1024);const db=lstatSync(join(path,'ledger.db'));if(!db.isFile()||db.isSymbolicLink()||db.size<100||db.size>maxDatabase)fail('REHEARSAL_FILE_INVALID');return{id,backupId:r.backupId,state:'saved' as const,createdAt:r.createdAt,bytes:r.files.reduce((n,f)=>n+f.bytes,0),summary:r.summary,activationBlocked:true};}catch{let state:'incomplete'|'invalid'='invalid';try{this.options.files.directory(join(this.root,id+'.pending'));if(!entries.includes(id))state='incomplete';}catch{}return{id,backupId:null,state,createdAt:null,bytes:null,summary:null,activationBlocked:true};}}).sort((a,b)=>(b.createdAt??0)-(a.createdAt??0)||a.id.localeCompare(b.id));
  }
  create(backupId:string,key:string):RehearsalView{
    try{
      this.anchor();const id=hash(key),existing=this.list().find(r=>r.id===id);if(existing){if(existing.state!=='saved')fail('REHEARSAL_INCOMPLETE_OR_INVALID');if(existing.backupId!==backupId)fail('IDEMPOTENCY_CONFLICT');return this.checked(id);}
      if(this.list().length>=20)fail('REHEARSAL_COUNT_LIMIT');const path=join(this.root,id+'.pending');mkdirSync(path,{mode:0o700});const identity=this.options.files.directory(path);writeFileSync(join(path,'RESTORE_QUARANTINE'),JSON.stringify({id,activation:'blocked'})+'\n',{flag:'wx',mode:0o600});this.options.files.sync(join(path,'RESTORE_QUARANTINE'));this.options.files.sync(path);
      this.options.copy(backupId,path);this.options.afterStage?.('copied');const current=this.options.watermarks(),summary=prepareRehearsalDatabase(join(path,'ledger.db'),current,id);
      const db=new DatabaseSync(join(path,'ledger.db'),{readOnly:true});let retained:string[];try{retained=db.prepare("SELECT relative_storage_key FROM artifacts WHERE state='published'").all().map(r=>String(r.relative_storage_key));}finally{db.close();}
      if(retained.length>512||retained.some(k=>!/^[a-f0-9-]{36}\.json$/.test(k)))fail('REHEARSAL_ARTIFACT_INVALID');const keep=new Set(retained);
      for(const name of readdirSync(join(path,'receipts'))){if(!/^[a-f0-9-]{36}\.json$/.test(name))fail('REHEARSAL_ARTIFACT_INVALID');if(!keep.has(name))rmSync(join(path,'receipts',name));}
      const files:RecordFile[]=[];for(const name of ['ledger.db','RESTORE_QUARANTINE',...retained.sort().map(n=>'receipts/'+n)]){const f=this.options.files.read(join(path,name),name==='ledger.db'?maxDatabase:maxReceipt);files.push({key:name,bytes:f.bytes,sha256:f.sha256});this.options.files.sync(join(path,name));}
      const report:Report={format:1,id,backupId,createdAt:Date.now(),currentWatermarkHash:hash(current),summary,files};writeFileSync(join(path,'report.json'),JSON.stringify(report)+'\n',{flag:'wx',mode:0o600});this.options.files.sync(join(path,'report.json'));this.options.files.sync(join(path,'receipts'));this.options.files.sync(path);this.checkedAt(path,id);
      this.anchor();if(this.options.files.directory(path)!==identity)fail('REHEARSAL_DIRECTORY_CHANGED');try{lstatSync(join(this.root,id));fail('REHEARSAL_TARGET_EXISTS');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}renameSync(path,join(this.root,id));this.options.files.sync(this.root);this.options.afterStage?.('published');return this.checked(id);
    }catch(error){throw error instanceof LedgerError?error:new LedgerError('REHEARSAL_OPERATION_FAILED');}
  }
  private checked(id:string):RehearsalView{return this.checkedAt(join(this.root,id),id);}
  private checkedAt(path:string,id:string):RehearsalView{
    this.anchor();const identity=this.options.files.directory(path),r=this.report(path,id);this.options.files.directory(join(path,'receipts'));
    if(JSON.stringify(readdirSync(path).sort())!==JSON.stringify(['RESTORE_QUARANTINE','ledger.db','receipts','report.json'].sort())||JSON.stringify(readdirSync(join(path,'receipts')).sort())!==JSON.stringify(r.files.filter(f=>f.key.startsWith('receipts/')).map(f=>f.key.slice(9)).sort()))fail('REHEARSAL_FILES_MISMATCH');
    for(const f of r.files){const value=this.options.files.read(join(path,f.key),f.key==='ledger.db'?maxDatabase:maxReceipt);if(value.bytes!==f.bytes||value.sha256!==f.sha256)fail('REHEARSAL_HASH_MISMATCH');}
    const db=new DatabaseSync(join(path,'ledger.db'),{readOnly:true});try{
      db.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON;');if(db.prepare('PRAGMA quick_check').get()?.quick_check!=='ok'||db.prepare('PRAGMA foreign_key_check').all().length||db.prepare('SELECT rehearsal_id FROM recovery_quarantine').get()?.rehearsal_id!==id||db.prepare('SELECT count(*) AS n FROM runtime_owners WHERE state<>\'stopped\' OR runtime_epoch<>?').get(r.summary.runtimeEpoch)?.n!==0||db.prepare('SELECT count(*) AS n FROM dots WHERE policy_epoch<>? OR privacy_epoch<>?').get(r.summary.policyEpoch,r.summary.privacyEpoch)?.n!==0||db.prepare("SELECT count(*) AS n FROM schedules WHERE state='active'").get()?.n!==0||db.prepare("SELECT count(*) AS n FROM approval_receipts WHERE state='granted'").get()?.n!==0)fail('REHEARSAL_STATE_INVALID');
      const rows=db.prepare("SELECT relative_storage_key,content_sha256,size_bytes FROM artifacts WHERE state='published'").all();if(rows.length!==r.files.length-2||rows.some(a=>!r.files.some(f=>f.key==='receipts/'+a.relative_storage_key&&f.sha256===a.content_sha256&&f.bytes===a.size_bytes)))fail('REHEARSAL_REFERENCES_MISMATCH');
    }finally{db.close();}
    let refused=false;try{const unexpected=new ExecutionLedger(join(path,'ledger.db'),'');unexpected.close();}catch(error){if(error instanceof LedgerError&&error.code==='RECOVERY_REHEARSAL_NOT_ACTIVE')refused=true;else throw error;}if(!refused)fail('REHEARSAL_ACTIVATION_GUARD_FAILED');if(this.options.files.directory(path)!==identity)fail('REHEARSAL_DIRECTORY_CHANGED');this.anchor();return{id,backupId:r.backupId,state:'saved',createdAt:r.createdAt,bytes:r.files.reduce((n,f)=>n+f.bytes,0),summary:r.summary,activationBlocked:true};
  }
}
