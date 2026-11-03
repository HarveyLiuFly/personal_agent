import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {ExecutionLedger} from '../../packages/store/src/ledger.ts';
import {WorktreeService} from '../../packages/workspace/src/worktrees.ts';
import {resolveVerifierNode} from '../../packages/codex-adapter/src/launch.ts';
const [file,cwd,state,git,stage]=process.argv.slice(2) as [string,string,string,string,string],store=new ExecutionLedger(file,readFileSync('docs/design/contracts/schema.sql','utf8'));store.startOwner('owned-worktree-recovery-fault',true);const project=store.registerWorkspace(cwd,cwd);let repair=false;
const stop=()=>{const current=store.currentWorktreeOperation(project.id)!;process.stdout.write(JSON.stringify({stage,projectId:project.id,operationId:current.operationId,workspaceId:current.payload.targetId})+'\n');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,15000);throw Error('CHILD_NOT_KILLED');};
const service=new WorktreeService(store,{git,node:resolveVerifierNode(resolve('.')),worker:resolve('packages/workspace/src/worktree-worker.mjs'),stateDirectory:state,afterArchived:()=>{if(stage==='archived')stop();throw Error('controlled archive gap');},afterPrepared:()=>{if(repair&&stage==='repair-prepared')stop();},afterGit:()=>{if(repair&&stage==='repair-result')stop();}});
const w=(await service.command({kind:'create',projectId:project.id,commandKey:'create',name:'owned recovery fixture'})).worktrees[0]!,inspection=service.inspect(project.id,w.id);const removed=await service.command({kind:'remove',projectId:project.id,workspaceId:w.id,expectedVersion:1,inspectionId:inspection.inspectionId,commandKey:'remove'});repair=true;await service.command({kind:'repairRemove',projectId:project.id,operationId:removed.operations[0]!.operationId,commandKey:'repair'});
