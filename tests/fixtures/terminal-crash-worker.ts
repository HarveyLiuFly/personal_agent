import {readFileSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {ExecutionLedger} from '../../packages/store/src/ledger.ts';
import {TerminalService} from '../../packages/workspace/src/terminal.ts';
import {resolveVerifierNode} from '../../packages/codex-adapter/src/launch.ts';
const [file,cwd,state,stage]=process.argv.slice(2) as [string,string,string,string],store=new ExecutionLedger(file,readFileSync('docs/design/contracts/schema.sql','utf8'));store.startOwner('owned-terminal-host-crash',true);const project=store.registerWorkspace(cwd,cwd);
const stop=()=>{process.stdout.write(JSON.stringify({projectId:project.id,stage})+'\n');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,15000);throw Error('CHILD_NOT_KILLED');};
const service=new TerminalService(store,{node:resolveVerifierNode(resolve('.')),worker:resolve('packages/workspace/src/terminal-worker.mjs'),stateDirectory:state,...(stage==='prepared'?{afterPrepared:stop}:{})});const view=await service.open({projectId:project.id,commandKey:'actual-crash-'+stage,cols:80,rows:24});if(stage==='running'){await service.write({projectId:project.id,sessionId:view.session!.sessionId,sequence:1,text:'sleep 120 & print $! > child.pid; wait\r'});const until=Date.now()+3000;while(!existsSync(join(cwd,'child.pid'))){if(Date.now()>until)throw Error('NO_OWNED_JOB_PID');await new Promise(done=>setTimeout(done,20));}stop();}
