import { createHash,randomUUID } from 'node:crypto';
import { execFileSync,spawn } from 'node:child_process';
import { chmodSync,existsSync,lstatSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,realpathSync,renameSync,rmSync,writeFileSync,openSync,fsyncSync,closeSync } from 'node:fs';
import { basename,dirname,isAbsolute,join,relative,resolve,sep } from 'node:path';
import { ExecutionLedger,LedgerError } from '../../store/src/ledger.ts';
import type { RunToken } from '../../store/src/ledger.ts';
import { isObject } from '../../codex-adapter/src/rpc.ts';
import { sandboxStdioFiles,sandboxStdioUsesFiles } from '../../codex-adapter/src/sandbox-stdio.ts';
export interface CodeInput { profile: 'node-test'; target: string; allowedPaths: string[] }
export interface TestCase { name:string; file:string; line:number; column:number; passed:boolean; skipped:boolean }
export interface TestResult { exitCode:number|null; timedOut:boolean; cases:TestCase[] }
export interface VerificationPlan {
  specId:string;runId:string;baselineCommit:string;target:string;allowedPaths:string[];
  files:Record<string,string>;testHash:string;nodeHash:string;reporterHash:string;cliHash:string;verifierHash:string;
  requiredCases:string[];knownCases:string[];commandArgv:string[];createdAt:number;
}
export interface VerificationReceipt {
  verificationId:string;runId:string;specId:string;status:'passed'|'failed'|'unknown';code:string;
  discovered:number;executed:number;skipped:number;exitCode:number|null;
  requiredCases:string[];passedCases:string[];changedFiles:string[];workspaceHash:string;observedAt:string;
}
export interface VerifierOptions { node:string;cli:string;reporter:string;stateDirectory:string;timeoutMs?:number; testRunner?:(cwd:string,target:string,signal?:AbortSignal)=>Promise<TestResult> }
const digest=(data:string|Buffer)=>createHash('sha256').update(data).digest('hex');
const fileHash=(path:string)=>digest(readFileSync(path));
const forbidden=new Set(['.git','.codex','.agents','.aws']);
function pathName(value:unknown):string {
  if(typeof value!=='string'||!value||value.length>300||/[\x00-\x1f\\]/.test(value)||isAbsolute(value)||value.split('/').some(p=>!p||p==='.'||p==='..')||value.split('/').some(p=>forbidden.has(p)))throw new LedgerError('INVALID_CODE_PATH');
  return value;
}
export function codeInput(value:unknown):CodeInput {
 if(!isObject(value)||Object.keys(value).length!==3||value.profile!=='node-test'||!Array.isArray(value.allowedPaths)||value.allowedPaths.length<1||value.allowedPaths.length>20)throw new LedgerError('INVALID_VERIFICATION_PROFILE');
 const target=pathName(value.target),allowedPaths=[...new Set(value.allowedPaths.map(pathName))];if(allowedPaths.includes(target))throw new LedgerError('TEST_MODIFICATION_NOT_ALLOWED');
 return{profile:'node-test',target,allowedPaths};
}
function git(cwd:string,args:string[]):string {
 const base=['--no-pager','--no-replace-objects','--no-optional-locks','-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null','-c','core.attributesFile=/dev/null','-c','core.untrackedCache=false','-c','maintenance.auto=false','-c','gc.auto=0','-C',cwd];
 const run=(argv:string[])=>execFileSync('git',[...base,...argv],{encoding:'utf8' as const,timeout:5000,maxBuffer:262144,stdio:['ignore','pipe','ignore'] as const,env:{PATH:process.env.PATH,HOME:'/var/empty',LANG:'C',LC_ALL:'C',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_ATTR_NOSYSTEM:'1',GIT_OPTIONAL_LOCKS:'0',GIT_TERMINAL_PROMPT:'0'}});
 try{
  let filters='';try{filters=run(['config','--includes','--name-only','--get-regexp','^filter\\.']);}catch(error){if((error as {status?:number}).status!==1)throw error;}
  if(filters.trim())throw new LedgerError('GIT_FILTERS_UNSUPPORTED');return run(args);
 }catch(error){if(error instanceof LedgerError)throw error;throw new LedgerError('GIT_BASELINE_UNAVAILABLE');}
}
export function workspaceFiles(cwd:string):Record<string,string>{
 const files:Record<string,string>={};let bytes=0,count=0;
 const walk=(directory:string)=>{for(const entry of readdirSync(directory,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
  if(forbidden.has(entry.name))continue;const full=join(directory,entry.name),key=relative(cwd,full).split(sep).join('/');
  const info=lstatSync(full);if(info.isSymbolicLink())throw new LedgerError('SYMLINK_PROJECT_UNSUPPORTED');
  if(info.isDirectory()){walk(full);continue;}if(!info.isFile())throw new LedgerError('SPECIAL_FILE_UNSUPPORTED');
  bytes+=info.size;if(++count>20000||bytes>64*1024*1024)throw new LedgerError('VERIFICATION_PROJECT_TOO_LARGE');
  files[key]=`${info.mode&0o777}:${fileHash(full)}`;
 }};walk(cwd);return files;
}
/** Linux: Codex's no-network seccomp filter rejects the socketpair Node's test runner needs for child
 * processes, so the single target file runs in-process. Tests that spawn piped children fail there. */
const linuxTestIsolation=process.platform==='linux'?['--test-isolation=none']:[];
const caseKey=(c:TestCase)=>JSON.stringify([c.file,c.line,c.column,c.name]);
export class NodeVerification {
 private store:ExecutionLedger;private options:VerifierOptions;
 constructor(store:ExecutionLedger,options:VerifierOptions){this.store=store;this.options=options;mkdirSync(options.stateDirectory,{recursive:true,mode:0o700});}
 private async tests(cwd:string,target:string,signal?:AbortSignal):Promise<TestResult>{
  if(this.options.testRunner)return this.options.testRunner(cwd,target,signal);
  const root=mkdtempSync(join(this.options.stateDirectory,'verify-')),home=join(root,'home'),scratch=join(root,'scratch');mkdirSync(home,{mode:0o700});mkdirSync(scratch,{mode:0o700});
  const readRoots=[dirname(dirname(this.options.node)),dirname(this.options.reporter)];
  if(process.platform==='darwin'&&existsSync('/System/Library/OpenSSL'))readRoots.push(realpathSync('/System/Library/OpenSSL'));
  if(process.platform==='linux'&&existsSync('/etc/ssl'))readRoots.push(realpathSync('/etc/ssl'));
  // Linux: bubblewrap re-executes the Codex binary as its codex-linux-sandbox helper inside the restricted view.
  if(process.platform==='linux')readRoots.push(this.options.cli);
  const config='[permissions.personal-agent-verifier]\nextends=":read-only"\n[permissions.personal-agent-verifier.filesystem]\n":root"="deny"\n":minimal"="read"\n'
   +readRoots.map(path=>`${JSON.stringify(path)}="read"\n`).join('')+`${JSON.stringify(scratch)}="write"\n`+'[permissions.personal-agent-verifier.filesystem.":workspace_roots"]\n"."="read"\n[permissions.personal-agent-verifier.network]\nenabled=false\n';
  writeFileSync(join(home,'config.toml'),config,{mode:0o600});
  const environment:NodeJS.ProcessEnv={PATH:process.env.PATH,HOME:home,CODEX_HOME:home,TMPDIR:scratch,LANG:'en_US.UTF-8',TZ:'UTC'};
  const files=sandboxStdioUsesFiles?sandboxStdioFiles(root):undefined;
  const child=spawn(this.options.cli,['sandbox','--include-managed-config','--permission-profile','personal-agent-verifier','-C',cwd,'--',this.options.node,'--test',...linuxTestIsolation,`--test-reporter=${this.options.reporter}`,'--',target],{cwd,env:environment,stdio:files?files.stdio:['ignore','pipe','pipe'],detached:process.platform!=='win32'});
  const cases:TestCase[]=[];let buffer='',bytes=0,timedOut=false;
  const kill=()=>{try{if(child.pid){if(process.platform==='win32')child.kill('SIGKILL');else process.kill(-child.pid,'SIGKILL');}}catch{}};
  const abort=()=>{timedOut=true;kill();};signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  const timer=setTimeout(abort,this.options.timeoutMs??30000);
  child.stderr?.on('data',()=>{});
  const consume=(chunk:Buffer)=>{
   bytes+=chunk.length;if(bytes>262144){abort();return;}buffer+=String(chunk);let i:number;
   while((i=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,i);buffer=buffer.slice(i+1);try{
    const d:unknown=JSON.parse(line);if(!isObject(d)||!['test:pass','test:fail'].includes(String(d.type))||typeof d.name!=='string'||d.name.length>500||typeof d.file!=='string'||!Number.isSafeInteger(d.line)||!Number.isSafeInteger(d.column)||typeof d.skipped!=='boolean'){abort();return;}
    const file=relative(cwd,d.file).split(sep).join('/');if(file!==target){abort();return;}
    if(cases.length>=500){abort();return;}cases.push({name:d.name,file,line:Number(d.line),column:Number(d.column),passed:d.type==='test:pass',skipped:d.skipped});
   }catch{abort();return;}}
  };
  child.stdout?.on('data',consume);
  try{const exitCode=await new Promise<number|null>((done)=>{child.once('error',()=>done(null));child.once('close',code=>{
    if(files){const output=files.output(262144);if(output===null)abort();else if(output.length)consume(output);}
    if(buffer.trim())timedOut=true;done(code);});});return{exitCode,timedOut,cases};}
  finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);files?.close();rmSync(root,{recursive:true,force:true});}
 }
 async prepare(token:RunToken,input:unknown,signal?:AbortSignal):Promise<void>{
  const profile=codeInput(input),run=this.store.runForHost(token.runId),workspace=this.store.workspace(run.workspaceId),cwd=workspace.directory;
  if(git(cwd,['status','--porcelain','--untracked-files=all','--','.']).trim())throw new LedgerError('WORKSPACE_NOT_CLEAN');
  const baselineCommit=git(cwd,['rev-parse','HEAD']).trim();if(!/^[a-f0-9]{40,64}$/.test(baselineCommit))throw new LedgerError('INVALID_GIT_BASELINE');
  const files=workspaceFiles(cwd);if(!files[profile.target]||!lstatSync(join(cwd,profile.target)).isFile())throw new LedgerError('TEST_TARGET_UNAVAILABLE');
  for(const path of profile.allowedPaths){const parent=dirname(resolve(cwd,path));if(!parent.startsWith(cwd+sep)&&parent!==cwd)throw new LedgerError('INVALID_CODE_PATH');}
  const baseline=await this.tests(cwd,profile.target,signal);
  const required=baseline.cases.filter(c=>!c.skipped).map(caseKey);
  if(signal?.aborted||baseline.timedOut||baseline.exitCode===null||required.length===0||new Set(required).size!==required.length)throw new LedgerError('BASELINE_TEST_EXECUTION_REQUIRED');
  if(JSON.stringify(files)!==JSON.stringify(workspaceFiles(cwd)))throw new LedgerError('BASELINE_WORKSPACE_CHANGED');
  const plan:VerificationPlan={specId:randomUUID(),runId:token.runId,baselineCommit,target:profile.target,allowedPaths:profile.allowedPaths,files,testHash:fileHash(join(cwd,profile.target)),nodeHash:fileHash(this.options.node),reporterHash:fileHash(this.options.reporter),cliHash:fileHash(this.options.cli),verifierHash:fileHash(import.meta.filename),requiredCases:required,knownCases:baseline.cases.map(caseKey),commandArgv:[this.options.node,'--test',`--test-reporter=${this.options.reporter}`,'--',profile.target],createdAt:Date.now()};
  this.store.installVerification(token,plan);
 }
 plan(projectId:string,runId:string):VerificationPlan|null{this.store.workspace(projectId);const run=this.store.runForHost(runId);if(run.workspaceId!==projectId)throw new LedgerError('RUN_NOT_IN_PROJECT');return this.store.verificationPlan(runId);}
 async prepareContinuation(token:RunToken,sourceRunId:string,signal?:AbortSignal):Promise<void>{
  const run=this.store.runForHost(token.runId),source=this.store.runForHost(sourceRunId),plan=this.plan(run.workspaceId,sourceRunId);
  if(!plan||run.taskId!==source.taskId||token.taskFence!==source.taskFence+1)throw new LedgerError('INVALID_VERIFICATION_CONTINUATION');
  const cwd=this.store.workspace(run.workspaceId).directory,current=workspaceFiles(cwd);
  if(fileHash(this.options.node)!==plan.nodeHash||fileHash(this.options.reporter)!==plan.reporterHash||fileHash(this.options.cli)!==plan.cliHash||fileHash(import.meta.filename)!==plan.verifierHash)throw new LedgerError('VERIFIER_CHANGED');
  if(fileHash(join(cwd,plan.target))!==plan.testHash)throw new LedgerError('TEST_MODIFIED');
  const changed=[...new Set([...Object.keys(plan.files),...Object.keys(current)])].filter(p=>plan.files[p]!==current[p]);
  if(changed.some(p=>!plan.allowedPaths.includes(p)))throw new LedgerError('CHANGES_OUTSIDE_CONTRACT');
  const baseline=await this.tests(cwd,plan.target,signal),executed=baseline.cases.filter(c=>!c.skipped).map(caseKey);
  if(signal?.aborted||baseline.timedOut||baseline.exitCode===null||plan.requiredCases.some(key=>!executed.includes(key))||baseline.cases.some(c=>!plan.knownCases.includes(caseKey(c))))throw new LedgerError('BASELINE_TEST_EXECUTION_REQUIRED');
  if(JSON.stringify(current)!==JSON.stringify(workspaceFiles(cwd)))throw new LedgerError('BASELINE_WORKSPACE_CHANGED');
  this.store.installVerification(token,{...plan,specId:randomUUID(),runId:token.runId,createdAt:Date.now()});
 }
 diff(projectId:string,runId:string):{changedFiles:string[];text:string;profile:VerificationPlan|null}{
  const plan=this.plan(projectId,runId);if(!plan)return{changedFiles:[],text:'',profile:null};const cwd=this.store.workspace(projectId).directory,current=workspaceFiles(cwd);
  const changedFiles=[...new Set([...Object.keys(plan.files),...Object.keys(current)])].filter(p=>plan.files[p]!==current[p]).sort();
  let text=git(cwd,['diff','--relative','--no-ext-diff','--no-textconv','--unified=3',plan.baselineCommit,'--','.']);for(const path of changedFiles){if(!plan.files[path]&&current[path]){const bytes=readFileSync(join(cwd,path));text+='\nNew file: '+path+'\n'+(bytes.includes(0)?'[binary file]':bytes.toString('utf8').slice(0,16384))+'\n';}}return{changedFiles,text:text.slice(0,65536),profile:plan};
 }
 result(projectId:string,runId:string):VerificationReceipt|null {
  this.plan(projectId,runId);const row=this.store.latestVerification(runId);if(!row)return null;
  if(!/^[a-f0-9-]{36}\.json$/.test(row.storageKey))throw new LedgerError('INVALID_RECEIPT_REFERENCE');
  const data=readFileSync(join(this.options.stateDirectory,'artifacts',row.storageKey));if(digest(data)!==row.hash)throw new LedgerError('VERIFICATION_RECEIPT_CHANGED');
  return JSON.parse(data.toString('utf8')) as VerificationReceipt;
 }

 async verify(projectId:string,runId:string,signal?:AbortSignal):Promise<VerificationReceipt>{
  const plan=this.plan(projectId,runId);if(!plan)throw new LedgerError('VERIFICATION_NOT_CONFIGURED');
  const claim=this.store.claimVerification(runId),cwd=this.store.workspace(projectId).directory;
  const receipt:VerificationReceipt={verificationId:randomUUID(),runId,specId:plan.specId,status:'failed',code:'NOT_RUN',discovered:0,executed:0,skipped:0,exitCode:null,requiredCases:plan.requiredCases,passedCases:[],changedFiles:[],workspaceHash:'',observedAt:new Date().toISOString()};
  let artifactPath:string|undefined;
  try{
   const before=workspaceFiles(cwd);receipt.changedFiles=[...new Set([...Object.keys(plan.files),...Object.keys(before)])].filter(p=>plan.files[p]!==before[p]).sort();receipt.workspaceHash=digest(JSON.stringify(before));
   if(fileHash(this.options.node)!==plan.nodeHash||fileHash(this.options.reporter)!==plan.reporterHash||fileHash(this.options.cli)!==plan.cliHash||fileHash(import.meta.filename)!==plan.verifierHash)throw new LedgerError('VERIFIER_CHANGED');
   if(fileHash(join(cwd,plan.target))!==plan.testHash)throw new LedgerError('TEST_MODIFIED');
   if(!receipt.changedFiles.length)throw new LedgerError('NO_CODE_CHANGE');
   if(receipt.changedFiles.some(path=>!plan.allowedPaths.includes(path)))throw new LedgerError('CHANGES_OUTSIDE_CONTRACT');
   const result=await this.tests(cwd,plan.target,signal);receipt.exitCode=result.exitCode;receipt.discovered=result.cases.length;receipt.executed=result.cases.filter(c=>!c.skipped).length;receipt.skipped=result.cases.filter(c=>c.skipped).length;receipt.passedCases=result.cases.filter(c=>c.passed&&!c.skipped).map(caseKey);
   if(result.timedOut||signal?.aborted||result.exitCode===null)throw new LedgerError('VERIFICATION_UNKNOWN');
   if(result.exitCode!==0)throw new LedgerError('TESTS_FAILED');
   if(!receipt.executed||plan.requiredCases.some(key=>!receipt.passedCases.includes(key))||result.cases.some(c=>!plan.knownCases.includes(caseKey(c))))throw new LedgerError('REQUIRED_CASES_NOT_EXECUTED');
   if(receipt.workspaceHash!==digest(JSON.stringify(workspaceFiles(cwd))))throw new LedgerError('WORKSPACE_CHANGED_DURING_VERIFICATION');
   receipt.status='passed';receipt.code='VERIFIED';
  }catch(error){receipt.code=error instanceof LedgerError?error.code:'VERIFIER_HOST_ERROR';if(receipt.code==='VERIFICATION_UNKNOWN')receipt.status='unknown';}
  try{
   const storage=join(this.options.stateDirectory,'artifacts');mkdirSync(storage,{recursive:true,mode:0o700});artifactPath=join(storage,`${receipt.verificationId}.json`);const temporary=artifactPath+'.tmp',json=JSON.stringify(receipt,null,2)+'\n';
   writeFileSync(temporary,json,{mode:0o600,flag:'wx'});const fd=openSync(temporary,'r');try{fsyncSync(fd);}finally{closeSync(fd);}renameSync(temporary,artifactPath);chmodSync(artifactPath,0o600);const directoryFd=openSync(storage,'r');try{fsyncSync(directoryFd);}finally{closeSync(directoryFd);}
   this.store.recordVerification(claim,plan,receipt,{storageKey:`${receipt.verificationId}.json`,hash:digest(json),bytes:Buffer.byteLength(json)});
   return receipt;
  }finally{this.store.releaseVerification(claim);}
 }
}
