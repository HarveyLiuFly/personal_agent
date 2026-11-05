import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdirSync,mkdtempSync,readFileSync,writeFileSync,realpathSync,existsSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:net';
import {verifiedCodex} from '../packages/codex-adapter/src/binary.ts';
import {resolveVerifierNode} from '../packages/codex-adapter/src/launch.ts';
import {WorkspaceService,resolveWorkspaceGit} from '../packages/workspace/src/service.ts';
import {ExecutionLedger,LedgerError} from '../packages/store/src/ledger.ts';
import {createWorkspaceFixture} from '../tests/fixtures/workspace-project.ts';
const root=resolve(import.meta.dirname,'..'),binary=verifiedCodex(root),node=resolveVerifierNode(root),git=resolveWorkspaceGit(),folder=realpathSync(mkdtempSync(join(tmpdir(),'personal-agent-workspace-native-'))),cwd=join(folder,'workspace');createWorkspaceFixture(cwd,git);
const store=new ExecutionLedger(join(folder,'ledger.db'),readFileSync(join(root,'docs/design/contracts/schema.sql'),'utf8'));store.startOwner(randomUUID(),true);const p=store.registerWorkspace(cwd),options={node,cli:binary.executable,git,worker:join(root,'packages/workspace/src/reader.mjs'),stateDirectory:join(folder,'state')},reader=new WorkspaceService(id=>store.workspace(id),options);
const digest=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');let connections=0;const server=createServer(socket=>{connections++;socket.destroy();});let evidence:Record<string,unknown>;
try{
 const index=digest(readFileSync(join(cwd,'.git/index'))),overview=await reader.overview({projectId:p.id});assert.equal(overview.git.available,true);assert.equal(overview.directory.entries.find(e=>e.name==='.env')!.id,null);
 const math=overview.git.changes.find(c=>c.path==='src/math.txt')!,staged=await reader.diff({projectId:p.id,changeId:math.id,part:'staged'}),unstaged=await reader.diff({projectId:p.id,changeId:math.id,part:'unstaged'});assert.ok(staged.text.includes('+staged fixture'));assert.ok(unstaged.text.includes('+unstaged fixture'));
 const src=overview.directory.entries.find(e=>e.name==='src')!,directory=await reader.list({projectId:p.id,entryId:src.id}),html=directory.entries.find(e=>e.name==='html.txt')!,preview=await reader.preview({projectId:p.id,entryId:html.id});assert.equal(preview.kind,'text');assert.ok(preview.text.includes('<img'));
 assert.equal(digest(readFileSync(join(cwd,'.git/index'))),index);assert.equal(readFileSync(join(cwd,'src/math.txt'),'utf8'),'unstaged fixture\n');
 await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));const address=server.address();assert.ok(address&&typeof address==='object');const outside=join(folder,'outside-canary');writeFileSync(outside,'public synthetic sentinel');
 const probe=join(folder,'boundary-probe.mjs');writeFileSync(probe,`import assert from 'node:assert/strict';import {readFileSync,writeFileSync} from 'node:fs';import net from 'node:net';
// Seatbelt refuses with EPERM/EACCES. Linux bubblewrap hides unmounted paths (ENOENT) and mounts allowed trees read-only (EROFS).
const deniedFs=${JSON.stringify(process.platform==='linux'?['EPERM','EACCES','ENOENT','EROFS']:['EPERM','EACCES'])};
try{
 assert.throws(()=>readFileSync(${JSON.stringify(outside)}),e=>deniedFs.includes(e.code));
 assert.throws(()=>readFileSync(${JSON.stringify(join(cwd,'.env'))}),e=>deniedFs.includes(e.code));
 assert.throws(()=>writeFileSync(${JSON.stringify(join(cwd,'forbidden-write'))},'x'),e=>deniedFs.includes(e.code));
 for(const name of ['CODEX_APP_TOOLS_PIPE_PATH','CODEX_THREAD_ID','CODEX_SESSION_ID','CODEX_API_KEY','OPENAI_API_KEY','AWS_ACCESS_KEY_ID','GOOGLE_APPLICATION_CREDENTIALS'])assert.equal(process.env[name],undefined);
 await new Promise((done,reject)=>{const socket=net.connect(${address.port},'127.0.0.1');socket.once('connect',()=>{socket.destroy();reject(new Error('NETWORK_ALLOWED'));});socket.once('error',e=>['EPERM','EACCES'].includes(e.code)?done():reject(e));socket.setTimeout(1500,()=>{socket.destroy();reject(new Error('NETWORK_NOT_CONFIRMED'));});});
 process.stdout.write(JSON.stringify({ok:true,data:{directory:{entries:[{name:'boundaries-passed',path:'boundaries-passed',kind:'blocked',size:0,identity:'',reason:'PROBE_ONLY'}],truncated:false},git:{available:false,branch:null,head:null,changes:[]}}}));
}catch{process.stdout.write(JSON.stringify({ok:false,code:'NATIVE_SANDBOX_BOUNDARY_FAILED'}));process.exitCode=1;}
`);
 const proof=await new WorkspaceService(id=>store.workspace(id),{...options,worker:probe,stateDirectory:join(folder,'probe-state')}).overview({projectId:p.id});assert.equal(proof.directory.entries[0]?.name,'boundaries-passed');assert.equal(connections,0);assert.equal(existsSync(join(cwd,'forbidden-write')),false);
 evidence={status:'passed',observedAt:new Date().toISOString(),kind:'real_filesystem_git_and_native_read_only_sandbox',platform:binary.platform,cliVersion:binary.lock.cliVersion,inferenceRequested:false,gitBackend:'real_system_git',sandbox:'real_locked_cli_permission_profile',ordinaryGitStatus:true,stagedAndUnstagedDiffSeparated:true,plainTextPreview:true,protectedFileNoGrant:true,indexUnchanged:true,sourceUnchangedByReads:true,outsideReadBlocked:true,protectedRootFileReadBlocked:true,workspaceWriteBlocked:true,loopbackNetworkBlocked:true,serverConnections:connections,parentToolBridgeAbsent:true,authenticationEnvironmentAbsent:true};
}catch(error){evidence={status:'blocked',observedAt:new Date().toISOString(),kind:'real_filesystem_git_and_native_read_only_sandbox',platform:binary.platform,inferenceRequested:false,code:error instanceof LedgerError?error.code:'PROBE_ASSERTION_FAILED',serverConnections:connections};process.exitCode=1;}
finally{if(server.listening)await new Promise<void>((done,reject)=>server.close(e=>e?reject(e):done()));store.close();}
const output=join(process.env.PERSONAL_AGENT_EVIDENCE_DIR?resolve(process.env.PERSONAL_AGENT_EVIDENCE_DIR):join(root,'docs/progress/evidence'),'M2.1a-native-workspace.json');mkdirSync(dirname(output),{recursive:true});writeFileSync(output,JSON.stringify(evidence,null,2)+'\n');writeFileSync(output.replace('.json',`-${String(evidence.observedAt).replaceAll(':','-').replaceAll('.','-')}.json`),JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify(evidence,null,2));
