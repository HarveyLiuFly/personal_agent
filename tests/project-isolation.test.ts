import {terminalAvailable} from '../packages/workspace/src/terminal-binding.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,realpathSync,rmSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {ExecutionLedger} from '../packages/store/src/ledger.ts';
import type {TerminalSession} from '../packages/contracts/src/terminal.ts';
import {TerminalService} from '../packages/workspace/src/terminal.ts';
import {resolveVerifierNode} from '../packages/codex-adapter/src/launch.ts';
test('two real simultaneous project PTYs keep cwd, input/output and leases separate; closing one leaves the other live',{skip:!terminalAvailable()},async t=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'personal-agent-project-isolation-'))),store=new ExecutionLedger(join(root,'ledger.db'),readFileSync('docs/design/contracts/schema.sql','utf8'));store.startOwner('isolation-owner',true);const service=new TerminalService(store,{node:resolveVerifierNode(resolve('.')),worker:resolve('packages/workspace/src/terminal-worker.mjs'),stateDirectory:join(root,'terminals')});t.after(async()=>{await service.stop();store.close();rmSync(root,{recursive:true,force:true});});
 const projects=['A','B'].map(name=>{const path=join(root,name);mkdirSync(path);return store.registerWorkspace(path,path);});const sessions:TerminalSession[]=[];
 for(const p of projects)sessions.push((await service.open({projectId:p.id,commandKey:'open-'+p.name,cols:80,rows:24})).session!);
 const text=(index:number)=>service.view({projectId:projects[index]!.id,afterSequence:0}).chunks.map(c=>Buffer.from(c.data,'base64').toString()).join('');
 for(let i=0;i<2;i++)await service.write({projectId:projects[i]!.id,sessionId:sessions[i]!.sessionId,sequence:1,text:`printf 'PUBLIC_${i}_ISOLATED\\n'; printf 'PUBLIC_${i}' > same-name.txt\r`});
 const until=Date.now()+7000;// bash echoes the line and its output in one burst slightly after the command runs; wait for both.
 const ready=()=>projects.every((p,i)=>existsSync(join(p.directory,'same-name.txt'))&&text(i).includes('PUBLIC_'+i+'_ISOLATED'));
 while(!ready()){if(Date.now()>until)throw Error('PROJECT_ISOLATION_TIMEOUT');await new Promise(r=>setTimeout(r,20));}
 for(let i=0;i<2;i++){assert.equal(readFileSync(join(projects[i]!.directory,'same-name.txt'),'utf8'),'PUBLIC_'+i);assert.ok(text(i).includes('PUBLIC_'+i+'_ISOLATED'));assert.equal(text(i).includes('PUBLIC_'+(1-i)+'_ISOLATED'),false);}
 assert.equal(store.resourceOccupancy().terminalActive,2);await assert.rejects(()=>service.write({projectId:projects[0]!.id,sessionId:sessions[1]!.sessionId,sequence:2,text:'WRONG_PROJECT\r'}),/TERMINAL_SCOPE_MISMATCH/);
 const other=store.terminalHost(projects[1]!.id,sessions[1]!.sessionId);await service.close({projectId:projects[0]!.id,sessionId:sessions[0]!.sessionId,commandKey:'close-A'});assert.equal(store.resourceOccupancy().terminalActive,1);assert.doesNotThrow(()=>process.kill(other.ptyPid!,0));await service.write({projectId:projects[1]!.id,sessionId:sessions[1]!.sessionId,sequence:2,text:"printf 'STILL_LIVE' >> same-name.txt\r"});const end=Date.now()+7000;while(!readFileSync(join(projects[1]!.directory,'same-name.txt'),'utf8').endsWith('STILL_LIVE')){if(Date.now()>end)throw Error('PROJECT_B_NOT_LIVE');await new Promise(r=>setTimeout(r,20));}assert.equal(readFileSync(join(projects[0]!.directory,'same-name.txt'),'utf8'),'PUBLIC_0');await service.close({projectId:projects[1]!.id,sessionId:sessions[1]!.sessionId,commandKey:'close-B'});assert.equal(store.resourceOccupancy().terminalActive,0);for(const p of projects)assert.equal(store.runs(p.id).length,0);
});
