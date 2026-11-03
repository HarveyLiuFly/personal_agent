import React,{useEffect,useRef,useState} from 'react';
import type {ProjectView} from '../../../packages/contracts/src/views.ts';
import type {ProjectSkillsView} from '../../../packages/contracts/src/skills.ts';
/** Keep the underlying composer mounted so browsing metadata cannot discard an unsent draft. */
export function ProjectSkillsDialog({project,onBusyChange,onClose}:{project:ProjectView;onBusyChange:(busy:boolean)=>void;onClose:()=>void}){
  const ref=useRef<HTMLDialogElement>(null);useEffect(()=>{const dialog=ref.current!;dialog.showModal();return()=>{if(dialog.open)dialog.close();};},[]);
  return <dialog ref={ref} className="skills-dialog" aria-label="项目技能与能力" onCancel={e=>{e.preventDefault();onClose();}}><div className="skills-dialog-actions"><button className="secondary" data-action="close-project-skills" onClick={onClose}>返回工作区</button></div><SkillsPanel project={project} onBusyChange={onBusyChange}/></dialog>;
}
export function SkillsPanel({project,onBusyChange}:{project:ProjectView;onBusyChange:(busy:boolean)=>void}){
  const [view,setView]=useState<ProjectSkillsView>(),[busy,setBusy]=useState(false),[error,setError]=useState<string>(),[filter,setFilter]=useState('');const alive=useRef(true),pending=useRef(false);
  async function refresh(){if(pending.current)return;pending.current=true;setBusy(true);setError(undefined);onBusyChange(true);try{const result=await window.personalAgent.listProjectSkills({projectId:project.id});if(!result.ok)throw Error(result.errorCode);if(alive.current)setView(result.value);}catch(e){if(alive.current)setError(e instanceof Error&&e.message==='RUNTIME_BUSY'?'当前有执行或读取正在处理，请稍后刷新目录。':'项目技能目录未更新，请检查项目后重试。');}finally{pending.current=false;if(alive.current){setBusy(false);onBusyChange(false);}}}
  useEffect(()=>{alive.current=true;void refresh();return()=>{alive.current=false;onBusyChange(false);};},[project.id]);
  const matches=view?.skills.filter(s=>[s.name,s.displayName??'',s.description].some(text=>text.toLocaleLowerCase().includes(filter.toLocaleLowerCase())))??[];
  return <section className="skills-panel" data-skills-panel data-skills-observed-at={view?.observedAt}><div className="history-heading"><h2>项目技能</h2><button className="secondary" data-action="refresh-project-skills" disabled={busy} onClick={()=>void refresh()}>{busy?'正在扫描…':'刷新目录'}</button></div>
    <p className="history-note">预览当前项目中发现的技能名称与说明，全局技能不在此列表。实际运行仍按运行时配置核对可用性。</p>
    {error&&<p className="notice error" role="alert" data-skills-stale>{error}{view&&' 以下保留上次目录结果。'}</p>}
    {view&&<><p className="history-note" data-skill-count>{view.skills.length} 项项目技能 · {new Date(view.observedAt).toLocaleString()}</p><section className="skills-capabilities" data-skill-capabilities><strong>当前应用执行策略</strong><p>MCP、插件与子 Agent 暂未启用。此页只展示目录，不安装或启用工具；远端 MCP 目录尚未加载。</p></section>
      {(view.scanErrors>0||view.invalidEntries>0)&&<p className="notice" data-skills-partial>部分元数据未能读取：扫描错误 {view.scanErrors} 项，无效记录 {view.invalidEntries} 项。</p>}
      {view.truncated&&<p className="notice" data-skills-truncated>目录或文本达到预览上限，仅显示部分内容。</p>}
      <label className="skill-filter">筛选技能<input aria-label="筛选项目技能" data-skill-filter value={filter} maxLength={200} onChange={e=>setFilter(e.target.value)}/></label>
      {matches.length===0&&<p className="history-note" data-skills-empty>{view.skills.length===0?'本次扫描没有发现可预览的项目技能。':'没有匹配的项目技能。'}</p>}
      <div>{matches.map(s=><article key={s.id} className="skill-card" data-skill-id={s.id} data-skill-name={s.name}><h3>{s.displayName??s.name}</h3>{s.displayName&&<small>{s.name}</small>}<p data-skill-description>{s.description||'没有可预览的说明。'}</p>{s.truncated&&<small>说明过长，仅显示部分内容。</small>}</article>)}</div>
    </>}
  </section>;
}
