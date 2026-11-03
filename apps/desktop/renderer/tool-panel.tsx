import React,{useState} from 'react';
import type {ItemView,RunView} from '../../../packages/contracts/src/views.ts';
import {toolActivities,toolStates} from './tool-activity.ts';
import type {ToolState} from './tool-activity.ts';

/** Read-only views of saved native events. No terminal input or tool execution handlers. */
export function AgentToolPanel({run}:{run:RunView}){
  const [kind,setKind]=useState('all'),[state,setState]=useState<ToolState|'all'>('all');
  const activities=toolActivities(run),visible=activities.filter(a=>(kind==='all'||a.item.kind===kind)&&(state==='all'||a.state===state));
  const kinds:Partial<Record<ItemView['kind'],string>>={command:'命令',files:'文件变更',tool:'其他工具',agent:'协作记录'};
  return <section className="agent-tools" data-agent-tools aria-label="Agent 工具记录">
    <div className="history-heading"><h3>Agent 工具记录</h3><span className="badge" data-tool-count>{activities.length} 条可见记录</span></div>
    <p className="history-note">工具结果以原生记录为准，任务完成以独立验证为准。</p>
    <div className="tool-filters">
      <label>类型<select aria-label="工具类型" data-tool-kind value={kind} onChange={e=>setKind(e.target.value)}><option value="all">全部类型</option>{Object.entries(kinds).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
      <label>状态<select aria-label="工具状态" data-tool-filter value={state} onChange={e=>setState(e.target.value as ToolState|'all')}><option value="all">全部状态</option>{Object.entries(toolStates).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
    </div>
    {!run.snapshot?<p className="history-note" data-tools-empty>尚无工具快照。</p>:activities.length===0?<p className="history-note" data-tools-empty>当前快照没有工具记录。</p>:visible.length===0?<p className="history-note" data-tools-empty>没有匹配的工具记录。</p>:null}
    {(run.snapshot?.truncated||run.snapshot?.unsupportedItems)&&<p className="notice" data-tools-partial>仅列出当前保留且支持的记录，不能据此统计完整工具次数。</p>}
    {run.snapshot?.needsSnapshot&&<p className="notice" data-tools-stale>这是最后保存的工具记录，连接状态待核对。</p>}
    <div className="tool-records">{visible.map(({item,state})=><details key={JSON.stringify([item.turnId,item.id])} className="tool-record" data-tool-id={item.id} data-tool-state={state}>
      <summary><strong>{item.label}</strong><span>{toolStates[state]}</span>{item.exitCode!==undefined&&<span data-tool-exit>退出码 {item.exitCode}</span>}{item.durationMs!==undefined&&<span>{item.durationMs} ms</span>}</summary>
      <small className="history-note">轮次 {item.turnId} · 记录 {item.id}</small>
      <pre data-tool-text>{item.text||'此记录没有文本详情。'}</pre>
      {item.truncated&&<small className="clip-note">仅显示部分内容</small>}
    </details>)}</div>
  </section>;
}
