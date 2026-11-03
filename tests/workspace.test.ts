import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,realpathSync,rmSync,renameSync,symlinkSync,chmodSync,existsSync,truncateSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {test} from 'node:test';
import {ExecutionLedger} from '../packages/store/src/ledger.ts';
import {WorkspaceService,resolveWorkspaceGit} from '../packages/workspace/src/service.ts';
function fixture(t:{after(fn:()=>void):void}){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'personal-agent-workspace-'))),cwd=join(root,'project');mkdirSync(cwd);mkdirSync(join(cwd,'src'));
 writeFileSync(join(cwd,'src/math.txt'),'original\n');writeFileSync(join(cwd,'space name.txt'),'base\n');writeFileSync(join(cwd,'.gitignore'),'.ignored\n');
 const git=(args:string[])=>execFileSync(resolveWorkspaceGit(),['-c','core.hooksPath=/dev/null','-C',cwd,...args],{encoding:'utf8',stdio:['ignore','pipe','ignore']});
 git(['init','--quiet']);git(['add','.']);git(['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--quiet','--no-gpg-sign','-m','controlled fixture']);
 const store=new ExecutionLedger(join(root,'store.db'),readFileSync('docs/design/contracts/schema.sql','utf8'));store.startOwner('workspace-component',true);const p=store.registerWorkspace(cwd),state=join(root,'state');
 const reader=new WorkspaceService(id=>store.workspace(id),{node:process.execPath,cli:process.execPath,git:resolveWorkspaceGit(),worker:resolve('packages/workspace/src/reader.mjs'),stateDirectory:state,withoutSandboxForTests:true});
 t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});return{root,cwd,p,store,state,reader,git};
}
test('real filesystem and Git observations separate staged, unstaged and untracked content without writes',async t=>{
 const f=fixture(t);writeFileSync(join(f.cwd,'src/math.txt'),'staged version\n');f.git(['add','src/math.txt']);writeFileSync(join(f.cwd,'src/math.txt'),'working version\n');writeFileSync(join(f.cwd,'untracked.txt'),'public fixture\n');writeFileSync(join(f.cwd,'.ignored'),'kept\n');
 const index=readFileSync(join(f.cwd,'.git/index')),head=f.git(['rev-parse','HEAD']);const view=await f.reader.overview({projectId:f.p.id});assert.equal(view.git.available,true);assert.equal(view.git.changes.length,2);
 const change=view.git.changes.find(c=>c.path==='src/math.txt')!;assert.equal(change.staged,'M');assert.equal(change.unstaged,'M');
 const a=await f.reader.diff({projectId:f.p.id,changeId:change.id,part:'staged'}),b=await f.reader.diff({projectId:f.p.id,changeId:change.id,part:'unstaged'});assert.ok(a.text.includes('+staged version'));assert.ok(b.text.includes('+working version'));
 assert.deepEqual(readFileSync(join(f.cwd,'.git/index')),index);assert.equal(f.git(['rev-parse','HEAD']),head);assert.equal(readFileSync(join(f.cwd,'.ignored'),'utf8'),'kept\n');
});
test('directory IDs support nested plain-text previews while HTML is returned strictly as text',async t=>{
 const f=fixture(t);writeFileSync(join(f.cwd,'src/html.txt'),'<img src=x onerror="window.bad=true">\n');const view=await f.reader.overview({projectId:f.p.id});
 const src=view.directory.entries.find(e=>e.name==='src')!,dir=await f.reader.list({projectId:f.p.id,entryId:src.id});assert.equal(dir.path,'src');assert.equal(dir.breadcrumbs.length,2);
 const file=dir.entries.find(e=>e.name==='html.txt')!,preview=await f.reader.preview({projectId:f.p.id,entryId:file.id});assert.equal(preview.kind,'text');assert.ok(preview.text.startsWith('<img'));assert.match(preview.contentHash!,/^[a-f0-9]{64}$/);
});
test('large Chinese and emoji previews preserve UTF-8 across process output chunks',async t=>{
 const f=fixture(t),text='中文😸'.repeat(10000);writeFileSync(join(f.cwd,'unicode.txt'),text);const view=await f.reader.overview({projectId:f.p.id}),entry=view.directory.entries.find(e=>e.name==='unicode.txt')!;
 const preview=await f.reader.preview({projectId:f.p.id,entryId:entry.id});assert.equal(preview.kind,'text');assert.equal(preview.bytes,100000);assert.equal(preview.text,text);
});
test('filenames with spaces and leading pathspec/option characters stay literal, including staged renames',async t=>{
 const f=fixture(t);f.git(['mv','space name.txt','renamed space.txt']);writeFileSync(join(f.cwd,':(glob)*.txt'),'literal\n');f.git(['add','--',':(literal):(glob)*.txt']);writeFileSync(join(f.cwd,'-options.txt'),'options\n');f.git(['add','--','-options.txt']);
 const view=await f.reader.overview({projectId:f.p.id});assert.equal(view.git.available,true);const moved=view.git.changes.find(c=>c.path==='renamed space.txt')!;assert.equal(moved.previousPath,'space name.txt');
 const movedDiff=await f.reader.diff({projectId:f.p.id,changeId:moved.id,part:'staged'});assert.ok(movedDiff.text.includes('renamed space.txt'));
 const literal=view.git.changes.find(c=>c.path===':(glob)*.txt')!,only=await f.reader.diff({projectId:f.p.id,changeId:literal.id,part:'staged'});assert.ok(only.text.includes('+literal'));assert.ok(!only.text.includes('options\n'));
});
test('fake IDs, raw paths, extra argv and cross-project handles are refused',async t=>{
 const f=fixture(t),view=await f.reader.overview({projectId:f.p.id}),file=view.directory.entries.find(e=>e.name==='space name.txt')!;
 mkdirSync(join(f.root,'other'));const other=f.store.registerWorkspace(join(f.root,'other'));
 for(const q of [{projectId:f.p.id,entryId:'/etc/passwd'},{projectId:f.p.id,entryId:file.id,path:'/etc/passwd'},{projectId:other.id,entryId:file.id}])await assert.rejects(f.reader.preview(q),/WORKSPACE_ENTRY_NOT_GRANTED|INVALID_WORKSPACE_QUERY/);
 await assert.rejects(f.reader.overview({projectId:f.p.id,args:['status']}),/INVALID_WORKSPACE_QUERY/);
});
test('refresh invalidates prior handles and an external edit cannot reuse an issued preview or Diff',async t=>{
 const f=fixture(t);writeFileSync(join(f.cwd,'src/math.txt'),'one\n');const first=await f.reader.overview({projectId:f.p.id});const old=first.directory.entries.find(e=>e.name==='space name.txt')!;
 await f.reader.overview({projectId:f.p.id});await assert.rejects(f.reader.preview({projectId:f.p.id,entryId:old.id}),/NOT_GRANTED/);
 const view=await f.reader.overview({projectId:f.p.id}),file=view.directory.entries.find(e=>e.name==='space name.txt')!,change=view.git.changes.find(c=>c.path==='src/math.txt')!;
 writeFileSync(join(f.cwd,'space name.txt'),'changed externally\n');await assert.rejects(f.reader.preview({projectId:f.p.id,entryId:file.id}),/ENTRY_CHANGED/);
 writeFileSync(join(f.cwd,'src/math.txt'),'two later\n');await assert.rejects(f.reader.diff({projectId:f.p.id,changeId:change.id,part:'unstaged'}),/ENTRY_CHANGED|GIT_CHANGED/);
});
test('symlinks, private configuration and local runtime caches never receive readable handles',async t=>{
 const f=fixture(t);writeFileSync(join(f.root,'outside'),'outside sentinel');symlinkSync(join(f.root,'outside'),join(f.cwd,'link'));writeFileSync(join(f.cwd,'.env.local'),'synthetic secret');writeFileSync(join(f.cwd,'.ENV.CASE'),'synthetic case fixture');mkdirSync(join(f.cwd,'.local'));writeFileSync(join(f.cwd,'.local/private'),'not visible');
 const view=await f.reader.overview({projectId:f.p.id});for(const name of ['link','.env.local','.ENV.CASE','.local','.git']){const e=view.directory.entries.find(e=>e.name===name)!;assert.equal(e.id,null);assert.equal(e.kind,'blocked');}
});
test('a directory replaced after issuing a grant remains rejected',async t=>{
 const f=fixture(t),view=await f.reader.overview({projectId:f.p.id}),src=view.directory.entries.find(e=>e.name==='src')!;
 renameSync(join(f.cwd,'src'),join(f.cwd,'old-src'));symlinkSync(f.root,join(f.cwd,'src'));await assert.rejects(f.reader.list({projectId:f.p.id,entryId:src.id}),/SYMLINK_BLOCKED|ENTRY_CHANGED/);
});
test('binary and oversized files return descriptions without their bytes',async t=>{
 const f=fixture(t);writeFileSync(join(f.cwd,'binary.dat'),Buffer.from([0,255,1]));writeFileSync(join(f.cwd,'large.txt'),'x'.repeat(140000));const view=await f.reader.overview({projectId:f.p.id});
 for(const [name,kind]of [['binary.dat','binary'],['large.txt','tooLarge']]){const entry=view.directory.entries.find(e=>e.name===name)!;const data=await f.reader.preview({projectId:f.p.id,entryId:entry.id});assert.equal(data.kind,kind);assert.equal(data.text,'');}
});
test('directory and Diff output limits return partial entries or refuse excessive content',async t=>{
 const f=fixture(t);mkdirSync(join(f.cwd,'many'));for(let n=0;n<205;n++)writeFileSync(join(f.cwd,'many',`file-${String(n).padStart(3,'0')}.txt`),'fixture\n');
 writeFileSync(join(f.cwd,'src/math.txt'),'bounded content\n'.repeat(30000));const view=await f.reader.overview({projectId:f.p.id});assert.equal(view.git.available,true);
 const dir=await f.reader.list({projectId:f.p.id,entryId:view.directory.entries.find(e=>e.name==='many')!.id});assert.equal(dir.entries.length,200);assert.equal(dir.truncated,true);
 await assert.rejects(f.reader.diff({projectId:f.p.id,changeId:view.git.changes.find(c=>c.path==='src/math.txt')!.id,part:'unstaged'}),/WORKSPACE_DIFF_TOO_LARGE/);
});
test('external Diff, textconv and fsmonitor programs cannot execute; configured clean filters are explicitly rejected',async t=>{
 const f=fixture(t),marker=join(f.root,'helper-executed'),helper=join(f.root,'helper.sh');writeFileSync(helper,`#!/bin/sh\ntouch '${marker}'\n`);chmodSync(helper,0o700);
 f.git(['config','core.fsmonitor',helper]);f.git(['config','diff.external',helper]);f.git(['config','diff.evil.textconv',helper]);writeFileSync(join(f.cwd,'.gitattributes'),'*.txt diff=evil\n');writeFileSync(join(f.cwd,'src/math.txt'),'new content\n');
 const view=await f.reader.overview({projectId:f.p.id});assert.equal(view.git.available,true);await f.reader.diff({projectId:f.p.id,changeId:view.git.changes.find(c=>c.path==='src/math.txt')!.id,part:'unstaged'});assert.equal(existsSync(marker),false);
 f.git(['config','filter.evil.clean',helper]);const next=await f.reader.overview({projectId:f.p.id});assert.equal(next.git.available,false);assert.equal(next.git.reason,'GIT_FILTERS_UNSUPPORTED');assert.equal(existsSync(marker),false);
 f.git(['config','--remove-section','filter.evil']);writeFileSync(join(f.cwd,'.git/filter-config'),`[filter "included"]\nclean = ${helper}\n`);f.git(['config','include.path','filter-config']);
 const included=await f.reader.overview({projectId:f.p.id});assert.equal(included.git.available,false);assert.equal(included.git.reason,'GIT_FILTERS_UNSUPPORTED');assert.equal(existsSync(marker),false);
});
test('linked Git metadata is not implicitly granted outside the workspace',async t=>{
 const f=fixture(t);renameSync(join(f.cwd,'.git'),join(f.root,'shared-git'));writeFileSync(join(f.cwd,'.git'),'gitdir: ../shared-git\n');const view=await f.reader.overview({projectId:f.p.id});assert.equal(view.git.available,false);assert.equal(view.git.reason,'LINKED_GIT_DIRECTORY_UNSUPPORTED');
});
test('a symbolic or excessive Git index is refused before invoking Git',async t=>{
 const f=fixture(t),index=join(f.cwd,'.git/index'),original=join(f.cwd,'.git/index-original');renameSync(index,original);symlinkSync(original,index);
 const linked=await f.reader.overview({projectId:f.p.id});assert.equal(linked.git.available,false);assert.equal(linked.git.reason,'GIT_INDEX_UNSUPPORTED');
 rmSync(index);writeFileSync(index,'');truncateSync(index,16777217);const large=await f.reader.overview({projectId:f.p.id});assert.equal(large.git.available,false);assert.equal(large.git.reason,'WORKSPACE_GIT_TOO_LARGE');
});
test('the frozen private reader cannot be replaced',async t=>{
 const f=fixture(t),program=join(f.state,readdirSync(f.state).find(n=>n.startsWith('reader-'))!);chmodSync(program,0o600);writeFileSync(program,'throw new Error("must not run")');await assert.rejects(f.reader.overview({projectId:f.p.id}),/READER_CHANGED/);
});
