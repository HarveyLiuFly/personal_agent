import {execFileSync,spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {existsSync,lstatSync,mkdirSync,readFileSync,realpathSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {createInterface} from 'node:readline';
import {ExecutionLedger,LedgerError,hashInput} from '../../store/src/ledger.ts';
import type {GitIdentity,GitWorkspaceSnapshot,WorktreeCommand,WorktreeDispatch,WorktreeInspection,WorktreePage} from '../../contracts/src/worktrees.ts';
const fail=(code:string):never=>{throw new LedgerError(code);};
const ident=(directory:string):GitIdentity=>{if(realpathSync(directory)!==directory||lstatSync(directory).isSymbolicLink())return fail('WORKTREE_IDENTITY_CHANGED');const s=lstatSync(directory,{bigint:true});if(!s.isDirectory())return fail('WORKTREE_IDENTITY_CHANGED');return{directory,device:String(s.dev),inode:String(s.ino)};};
const same=(a:GitIdentity,b:GitIdentity)=>hashInput(a)===hashInput(b);
const base=['--no-pager','--no-optional-locks','--no-replace-objects','--literal-pathspecs','-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null','-c','core.attributesFile=/dev/null','-c','core.untrackedCache=false','-c','maintenance.auto=false','-c','gc.auto=0','-c','color.ui=false','-c','submodule.recurse=false','-c','protocol.allow=never'];
export interface WorktreeOptions {git:string;node:string;worker:string;stateDirectory:string;/** Fault hooks are trusted test-only, never IPC. */afterPrepared?:()=>void;afterDispatch?:()=>void;afterGit?:()=>void}
/** Local Git operations, separate from model Runs and their execution Intents. */
export class WorktreeService {
 private store:ExecutionLedger;private options:WorktreeOptions;private env:NodeJS.ProcessEnv;private inspections=new Map<string,{scope:string;hash:string;at:number;inspection:WorktreeInspection}>();private running=new Set<Promise<unknown>>();private stopped=false;private workerHash:string;
 constructor(store:ExecutionLedger,options:WorktreeOptions){this.store=store;this.options=options;mkdirSync(options.stateDirectory,{recursive:true,mode:0o700});mkdirSync(join(options.stateDirectory,'home'),{recursive:true,mode:0o700});mkdirSync(join(options.stateDirectory,'trees'),{recursive:true,mode:0o700});mkdirSync(join(options.stateDirectory,'removed'),{recursive:true,mode:0o700});this.workerHash=hashInput(readFileSync(options.worker).toString('base64'));this.env={PATH:dirname(options.git),HOME:join(options.stateDirectory,'home'),TMPDIR:options.stateDirectory,LANG:'C',LC_ALL:'C',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0',GIT_ATTR_NOSYSTEM:'1',GIT_OPTIONAL_LOCKS:'0'};}
 private git(cwd:string,args:string[],optional=false):string {try{return execFileSync(this.options.git,[...base,'-C',cwd,...args],{env:this.env,timeout:5000,maxBuffer:262144,encoding:'utf8',stdio:['ignore','pipe','ignore']});}catch(e){if(optional&&(e as {status:number}).status===1)return '';return fail('WORKTREE_GIT_UNAVAILABLE');}}
 snapshot(directory:string,expected?:GitWorkspaceSnapshot,allowLinked=false):GitWorkspaceSnapshot {
  const rootIdentity=ident(directory),dot=join(directory,'.git');if(!existsSync(dot)||lstatSync(dot).isSymbolicLink())return fail('WORKTREE_GIT_METADATA_UNSUPPORTED');
  if(!lstatSync(dot).isDirectory()&&!allowLinked)return fail('WORKTREE_UNMANAGED_LINK');
  if(this.git(directory,['rev-parse','--show-toplevel']).trim()!==directory)return fail('WORKTREE_ROOT_MISMATCH');
  const gitDir=realpathSync(this.git(directory,['rev-parse','--absolute-git-dir']).trim()),commonDir=realpathSync(resolve(directory,this.git(directory,['rev-parse','--git-common-dir']).trim()));
  if(lstatSync(dot).isDirectory()&&(gitDir!==dot||commonDir!==dot))return fail('WORKTREE_GIT_METADATA_UNSUPPORTED');
  const gitIdentity=ident(gitDir),commonIdentity=ident(commonDir);if(expected&&(!same(rootIdentity,expected.rootIdentity)||!same(gitIdentity,expected.gitIdentity)||!same(commonIdentity,expected.commonIdentity)))return fail('WORKTREE_IDENTITY_CHANGED');
  if(existsSync(join(directory,'.gitmodules'))||/(?:^|\0)160000 /.test(this.git(directory,['ls-files','--stage','-z'])))return fail('WORKTREE_SUBMODULES_UNSUPPORTED');
  if(this.git(directory,['config','--includes','--name-only','--get-regexp','^filter\\.'],true))return fail('WORKTREE_FILTERS_UNSUPPORTED');
  const head=this.git(directory,['rev-parse','--verify','HEAD^{commit}']).trim();if(!/^[a-f0-9]{40,64}$/.test(head))return fail('WORKTREE_COMMIT_REQUIRED');
  return{directory,rootIdentity,head,gitDir,commonDir,gitIdentity,commonIdentity};
 }
 private source(scope:string):GitWorkspaceSnapshot {const c=this.store.worktreeContext(scope);return this.snapshot(c.root);}
 page(scope:string):WorktreePage {const context=this.store.worktreeContext(scope);return{worktrees:this.store.worktreeList(scope),operations:this.store.worktreeOperations(scope),canCreate:existsSync(join(context.root,'.git'))&&lstatSync(join(context.root,'.git')).isDirectory()};}
 private removal(scope:string,workspaceId:string):{inspection:WorktreeInspection;snapshot:GitWorkspaceSnapshot;hash:string} {
  if(this.store.worktreeContext(scope).projectId!==this.store.worktreeContext(workspaceId).projectId)return fail('WORKTREE_SCOPE_MISMATCH');
  const managed=this.store.managedWorktree(workspaceId);if(managed.state!=='ready')return fail('WORKTREE_NOT_READY');const expected=this.store.worktreeMetadata(workspaceId)??fail('WORKTREE_NOT_MANAGED'),snapshot=this.snapshot(managed.directory,expected,true),source=this.source(scope);
  if(snapshot.commonDir!==source.commonDir)return fail('WORKTREE_SCOPE_MISMATCH');
  if(this.git(managed.directory,['symbolic-ref','--quiet','--short','HEAD'],true).trim()!==managed.branch)return fail('WORKTREE_BRANCH_CHANGED');
  const status=this.git(managed.directory,['status','--porcelain=v2','--untracked-files=all','--ignored=matching','-z']);let trackedChanges=0,untracked=0,ignored=0;for(const row of status.split('\0')){if(!row)continue;if(row.startsWith('? '))untracked++;else if(row.startsWith('! '))ignored++;else trackedChanges++;}
  const unmergedCommits=!this.ancestor(managed.directory,snapshot.head,source.head),pendingTasks=this.store.worktreePendingTasks(workspaceId);
  const reasons=[...(trackedChanges?['TRACKED_CHANGES']:[]),...(untracked?['UNTRACKED_FILES']:[]),...(ignored?['IGNORED_FILES']:[]),...(unmergedCommits?['UNMERGED_COMMITS']:[]),...(pendingTasks?['PENDING_TASKS']:[])];
  const inspection:WorktreeInspection={inspectionId:randomUUID(),workspaceId,version:managed.version,canRemove:!reasons.length,reasons,trackedChanges,untracked,ignored,unmergedCommits,pendingTasks};return{inspection,snapshot,hash:hashInput({snapshot,status,pendingTasks,version:managed.version,sourceHead:source.head})};
 }
 private ancestor(cwd:string,a:string,b:string):boolean {try{execFileSync(this.options.git,[...base,'-C',cwd,'merge-base','--is-ancestor',a,b],{env:this.env,timeout:5000,stdio:'ignore'});return true;}catch(e){if((e as {status:number}).status===1)return false;return fail('WORKTREE_GIT_UNAVAILABLE');}}
 inspect(scope:string,workspaceId:string):WorktreeInspection {const data=this.removal(scope,workspaceId);for(const [id,row]of this.inspections)if(Date.now()-row.at>30000)this.inspections.delete(id);if(this.inspections.size>=1000)return fail('WORKTREE_INSPECTION_LIMIT');this.inspections.set(data.inspection.inspectionId,{scope,hash:data.hash,at:Date.now(),inspection:data.inspection});return data.inspection;}
 async command(input:WorktreeCommand):Promise<WorktreePage> {
  if(this.stopped)return fail('WORKTREE_SERVICE_STOPPED');this.validate(input);
  if(input.kind==='reconcile'){await this.reconcile(input.projectId,input.operationId);return this.page(input.projectId);}
  const normalized=input.kind==='create'?{kind:input.kind,projectId:input.projectId,name:input.name}:{kind:input.kind,projectId:input.projectId,workspaceId:input.workspaceId,expectedVersion:input.expectedVersion,inspectionId:input.inspectionId};
  const previous=this.store.worktreeReplay(input.projectId,input.commandKey,normalized,input.kind);if(previous)return this.page(input.projectId);
  const source=this.source(input.projectId);let target;
  if(input.kind==='remove'){
   if(input.workspaceId===input.projectId)return fail('WORKTREE_SWITCH_BEFORE_REMOVE');const receipt=this.inspections.get(input.inspectionId);if(!receipt||receipt.scope!==input.projectId||receipt.inspection.workspaceId!==input.workspaceId||Date.now()-receipt.at>30000||receipt.inspection.version!==input.expectedVersion)return fail('WORKTREE_INSPECTION_EXPIRED');
   const fresh=this.removal(input.projectId,input.workspaceId);if(!fresh.inspection.canRemove)return fail('WORKTREE_REMOVE_UNSAFE');if(fresh.hash!==receipt.hash)return fail('WORKTREE_INSPECTION_CHANGED');target={workspaceId:input.workspaceId,version:input.expectedVersion,snapshot:fresh.snapshot,inspectionHash:fresh.hash};
  }
  const op=this.store.prepareWorktree(input.projectId,input.commandKey,normalized,input.kind,source,join(this.options.stateDirectory,'trees'),target);this.options.afterPrepared?.();
  const work=this.execute(input.projectId,op);this.running.add(work);try{await work;}finally{this.running.delete(work);}return this.page(input.projectId);
 }
 private validate(q:WorktreeCommand){if(!q||typeof q!=='object'||Array.isArray(q)||typeof q.projectId!=='string')return fail('INVALID_WORKTREE_COMMAND');const keys=q.kind==='create'?['kind','projectId','commandKey','name']:q.kind==='remove'?['kind','projectId','commandKey','workspaceId','expectedVersion','inspectionId']:q.kind==='reconcile'?['kind','projectId','operationId']:[];if(!keys.length||Object.keys(q).length!==keys.length||Object.keys(q).some(k=>!keys.includes(k)))return fail('INVALID_WORKTREE_COMMAND');for(const [key,value]of Object.entries(q))if(key!=='expectedVersion'&&(typeof value!=='string'||!value||value.length>200||/[\x00-\x1f]/.test(value)))return fail('INVALID_WORKTREE_COMMAND');if(q.kind==='remove'&&(!Number.isSafeInteger(q.expectedVersion)||q.expectedVersion<1))return fail('INVALID_WORKTREE_COMMAND');}
 private async execute(scope:string,op:WorktreeDispatch):Promise<void> {
  let sent=false;try{
   if(hashInput(readFileSync(this.options.worker).toString('base64'))!==this.workerHash)return fail('WORKTREE_WORKER_CHANGED');this.snapshot(op.payload.executionDirectory,op.payload.source);
   if(op.kind==='remove'){const fresh=this.removal(scope,op.payload.targetId);if(!fresh.inspection.canRemove||fresh.hash!==op.payload.inspectionHash)return fail('WORKTREE_INSPECTION_CHANGED');}
   else if(existsSync(op.payload.targetDirectory))return fail('WORKTREE_TARGET_EXISTS');
   const args=op.kind==='create'?['worktree','add','--no-track','-b',op.payload.branch,'--',op.payload.targetDirectory,op.payload.baseCommit]:['worktree','remove','--',op.payload.targetDirectory];
   const child=spawn(this.options.node,[this.options.worker],{cwd:this.options.stateDirectory,env:{PATH:dirname(this.options.node),HOME:this.env.HOME},stdio:['pipe','pipe','pipe'],detached:true}),nonce=randomUUID();
   let result:{code:number|null}|undefined,protocolError=false,bytes=0;const lines=createInterface({input:child.stdout});child.stderr.on('data',data=>{bytes+=data.length;if(bytes>1048576)child.stdin.end();});child.stdin.on('error',()=>{});
   lines.on('line',line=>{try{bytes+=line.length;if(bytes>16384)throw Error();const data=JSON.parse(line);if(data.kind==='ready'&&!sent&&data.pid===child.pid&&data.nonce===nonce){this.store.dispatchWorktree(scope,op.operationId,data.pid);sent=true;this.options.afterDispatch?.();child.stdin.write(JSON.stringify({kind:'go',nonce})+'\n');}else if(data.kind==='result'&&sent&&!result)result=data;else throw Error();}catch{protocolError=true;child.stdin.end();}});
   child.stdin.write(JSON.stringify({kind:'configure',nonce,git:this.options.git,args:[...base,'-C',op.payload.executionDirectory,...args],cwd:op.payload.executionDirectory,env:this.env,...(op.kind==='remove'?{archive:{source:op.payload.targetDirectory,target:op.payload.recoveryDirectory,identity:op.payload.target!.rootIdentity}}:{})})+'\n');
   const timer=setTimeout(()=>child.stdin.end(),35000);await new Promise<void>((done,reject)=>{child.once('error',reject);child.once('close',()=>done());}).finally(()=>clearTimeout(timer));
   if(child.pid&&!this.groupGone(child.pid))return fail('WORKTREE_PROCESS_NOT_STOPPED');if(protocolError||!result)return fail('WORKTREE_RECEIPT_MISSING');this.options.afterGit?.();
   if(result.code!==0)return fail('WORKTREE_GIT_WRITE_FAILED');
   if(op.kind==='create'){const snapshot=this.snapshot(op.payload.targetDirectory,undefined,true);if(this.git(snapshot.directory,['symbolic-ref','--quiet','--short','HEAD']).trim()!==op.payload.branch)return fail('WORKTREE_RESULT_MISMATCH');this.store.finishWorktree(scope,op.operationId,'completed',snapshot);}
   else {if(!op.payload.recoveryDirectory||!same(ident(op.payload.recoveryDirectory),{...op.payload.target!.rootIdentity,directory:op.payload.recoveryDirectory}))return fail('WORKTREE_RECOVERY_MISSING');if(existsSync(op.payload.targetDirectory))return fail('WORKTREE_REMOVE_INCOMPLETE');this.store.finishWorktree(scope,op.operationId,'completed');}
  }catch(error){this.store.finishWorktree(scope,op.operationId,sent?'outcome_unknown':'failed',undefined,error instanceof LedgerError?error.code:'WORKTREE_OPERATION_FAILED');}
 }
 private groupGone(pid:number):boolean {try{process.kill(-pid,0);return false;}catch(e){return(e as NodeJS.ErrnoException).code==='ESRCH';}}
 private async reconcile(scope:string,operationId:string):Promise<void> {
  const op=this.store.worktreeDispatch(scope,operationId);if(op.state!=='outcome_unknown')return fail('WORKTREE_NOT_UNKNOWN');if(op.supervisorPid&&!this.groupGone(op.supervisorPid))return fail('WORKTREE_PROCESS_NOT_STOPPED');this.snapshot(op.payload.executionDirectory,op.payload.source);
  const registered=this.git(op.payload.executionDirectory,['worktree','list','--porcelain','-z']).split('\0').some(line=>line==='worktree '+op.payload.targetDirectory);
  if(op.kind==='create'){
   if(existsSync(op.payload.targetDirectory)){const target=this.snapshot(op.payload.targetDirectory,undefined,true);if(!registered||this.git(target.directory,['symbolic-ref','--short','HEAD']).trim()!==op.payload.branch||target.head!==op.payload.baseCommit)return fail('WORKTREE_RECONCILIATION_AMBIGUOUS');this.store.finishWorktree(scope,operationId,'completed',target,undefined,true);}
   else if(!registered){this.store.finishWorktree(scope,operationId,'failed',undefined,'WORKTREE_ABSENT_BRANCH_PRESERVED',true);}else return fail('WORKTREE_RECONCILIATION_AMBIGUOUS');
  }else if(!existsSync(op.payload.targetDirectory)&&!registered){if(!op.payload.recoveryDirectory||!same(ident(op.payload.recoveryDirectory),{...op.payload.target!.rootIdentity,directory:op.payload.recoveryDirectory}))return fail('WORKTREE_RECOVERY_MISSING');this.store.finishWorktree(scope,operationId,'completed',undefined,undefined,true);}
  else if(registered&&existsSync(op.payload.targetDirectory)){this.snapshot(op.payload.targetDirectory,op.payload.target,true);this.store.finishWorktree(scope,operationId,'failed',undefined,'WORKTREE_REMOVE_NOT_APPLIED',true);}else return fail('WORKTREE_RECONCILIATION_AMBIGUOUS');
 }
 async stop(){this.stopped=true;await Promise.allSettled([...this.running]);}
}
