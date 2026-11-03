import React,{useEffect,useRef,useState} from 'react';
import type {HostResult,ProjectView} from '../../../packages/contracts/src/views.ts';
import type {WorkspaceOverview,WorkspaceDirectory,WorkspacePreview,WorkspaceDiff,WorkspaceEntry,WorkspaceChange} from '../../../packages/contracts/src/workspace.ts';
async function value<T>(promise:Promise<HostResult<T>>):Promise<T>{const r=await promise;if(!r.ok)throw new Error(r.errorCode);return r.value;}
const size=(bytes:number)=>bytes<1024?`${bytes} B`:bytes<1048576?`${(bytes/1024).toFixed(1)} KB`:`${(bytes/1048576).toFixed(1)} MB`;
function message(code:string){
 if(code==='RUNTIME_BUSY'||code==='WORKSPACE_READ_BUSY')return'当前正在执行或读取，请稍后刷新工作区。';
 if(/CHANGED|NOT_GRANTED|IDENTITY/.test(code))return'文件或目录已发生变化，请刷新后重新选择。';
 if(code==='WORKSPACE_DIFF_TOO_LARGE')return'Diff 超过预览上限。';
 return'暂时无法读取此项，请刷新或选择其他文件。';
}
export function WorkspacePanel({project,onBusyChange}:{project:ProjectView;onBusyChange:(busy:boolean)=>void}){
 const [overview,setOverview]=useState<WorkspaceOverview>(),[directory,setDirectory]=useState<WorkspaceDirectory>();
 const [tab,setTab]=useState<'files'|'git'>('files'),[preview,setPreview]=useState<WorkspacePreview|WorkspaceDiff>(),[busy,setBusy]=useState(false),[error,setError]=useState<string>();
 const alive=useRef(true),pending=useRef(false);
 async function perform(work:()=>Promise<void>){if(pending.current)return;pending.current=true;setBusy(true);setError(undefined);onBusyChange(true);
  try{await work();}catch(e){if(alive.current)setError(message(e instanceof Error?e.message:''));}
  finally{pending.current=false;if(alive.current){setBusy(false);onBusyChange(false);}}
 }
 const refresh=()=>perform(async()=>{const next=await value(window.personalAgent.getWorkspace({projectId:project.id}));if(alive.current){setOverview(next);setDirectory(next.directory);setPreview(undefined);}});
 useEffect(()=>{alive.current=true;void refresh();return()=>{alive.current=false;onBusyChange(false);};},[project.id]);
 const open=(entry:WorkspaceEntry)=>perform(async()=>{if(!entry.id)return;if(entry.kind==='directory'){const next=await value(window.personalAgent.listWorkspaceDirectory({projectId:project.id,entryId:entry.id}));if(alive.current){setDirectory(next);setPreview(undefined);}}
  else{const next=await value(window.personalAgent.readWorkspaceFile({projectId:project.id,entryId:entry.id}));if(alive.current)setPreview(next);}});
 const diff=(change:WorkspaceChange,part:'staged'|'unstaged')=>perform(async()=>{if(!change.id)return;const next=await value(window.personalAgent.getWorkspaceDiff({projectId:project.id,changeId:change.id,part}));if(alive.current)setPreview(next);});
 return <section className="workspace-panel" data-workspace-panel>
  <div className="workspace-heading"><div><h2>工作区</h2><span className="history-note">{overview?.git.available?`${overview.git.branch??'分离 HEAD'} · ${overview.git.head?.slice(0,10)??'尚无提交'}`:project.name}</span></div><span className="badge">只读预览</span><button className="secondary" data-action="refresh-workspace" disabled={busy} onClick={()=>void refresh()}>刷新</button></div>
  {error&&<div className="notice error" role="alert">{error}</div>}
  <div className="workspace-columns">
   <aside className="workspace-explorer"><div className="workspace-tabs"><button data-action="workspace-files" aria-pressed={tab==='files'} onClick={()=>setTab('files')}>文件</button><button data-action="workspace-git" aria-pressed={tab==='git'} onClick={()=>setTab('git')}>Git 变更 {overview?.git.available?overview.git.changes.length:''}</button></div>
    {tab==='files'?<>
     <nav className="workspace-crumbs" aria-label="工作区路径">{directory?.breadcrumbs.map(c=><button key={c.id} disabled={busy} onClick={()=>void perform(async()=>{const next=await value(window.personalAgent.listWorkspaceDirectory({projectId:project.id,entryId:c.id}));if(alive.current){setDirectory(next);setPreview(undefined);}})}>{c.name} /</button>)}</nav>
     <div className="workspace-entries">{directory?.entries.map(entry=><button key={entry.path} data-workspace-path={entry.path} className="workspace-entry" disabled={busy||!entry.id} onClick={()=>void open(entry)} title={entry.path}><span>{entry.kind==='directory'?'▸':entry.kind==='blocked'?'⌑':'·'} {entry.name}</span><small>{entry.kind==='file'?size(entry.size):entry.kind==='blocked'?'受保护':''}</small></button>)}</div>
     {directory?.truncated&&<p className="history-note">仅显示此目录的部分条目。</p>}
    </>:<div className="workspace-changes">{!overview?.git.available?<p className="history-note" data-git-unavailable>当前目录的 Git 状态暂不可用。此版本支持仓库根目录内的普通 Git 元数据。</p>:overview.git.changes.length===0?<p className="history-note">没有 Git 变更。</p>:overview.git.changes.map(change=><article key={change.path} className="workspace-change" data-git-path={change.path}>
     <strong>{change.path}</strong>{change.previousPath&&<small>← {change.previousPath}</small>}<small>{change.conflict?'存在冲突':change.untracked?'未跟踪':`${change.staged} ${change.unstaged}`}</small>
     {change.reason?<small>受保护</small>:change.untracked?<small>从文件列表选择可预览内容</small>:<div><button disabled={busy||!change.id||change.staged==='.'} data-diff-part="staged" onClick={()=>void diff(change,'staged')}>已暂存</button><button disabled={busy||!change.id||change.unstaged==='.'} data-diff-part="unstaged" onClick={()=>void diff(change,'unstaged')}>未暂存</button></div>}
    </article>)}</div>}
   </aside>
   <div className="workspace-document">{preview?<><div className="workspace-document-title"><strong>{preview.path}</strong><span className="badge">{'part'in preview?(preview.part==='staged'?'已暂存 Diff':'未暂存 Diff'):'文件'}</span></div>
    {'kind'in preview&&preview.kind!=='text'?<p className="history-note" data-workspace-preview-kind={preview.kind}>{preview.kind==='binary'?'二进制或非 UTF-8 文件不显示文本。':'文件超过 128 KB 预览上限。'}（{size(preview.bytes)}）</p>:<pre data-workspace-preview>{preview.text||'文件或 Diff 为空。'}</pre>}
   </>:<div className="workspace-empty"><span>⌘</span><h3>{busy?'正在读取工作区…':'选择文件或 Git 变更'}</h3><p>查看代码内容、已暂存与未暂存的差异。</p></div>}</div>
  </div>
 </section>;
}
