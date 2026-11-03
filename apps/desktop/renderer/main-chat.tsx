import React,{useEffect,useRef,useState} from 'react';
import {ChatRoutePanel} from './chat-route-panel.tsx';
import type {ProjectView,HostResult} from '../../../packages/contracts/src/views.ts';
import type {MainChatInput,MainChatView} from '../../../packages/contracts/src/chat.ts';
async function value<T>(p:Promise<HostResult<T>>){const r=await p;if(!r.ok)throw Error(r.errorCode);return r.value;}
const statusName:Record<string,string>={created:'待处理',queued:'排队中',running:'执行中',waiting_input:'等待补充',waiting_approval:'等待批准',waiting_trigger:'等待触发',paused:'已暂停',needs_review:'待审查',completed:'已完成',failed:'失败',cancelled:'已取消',outcome_unknown:'结果待核对'};
const errorText=(e:unknown)=>e instanceof Error&&e.message==='CHAT_FOCUS_CHANGED'?'讨论对象已在另一处变化，请刷新并确认目标后再次发送。':e instanceof Error&&/CLARIFICATION|CANDIDATE/.test(e.message)?'澄清问题或任务版本已变化，请重新查询。':'本次消息尚未确认保存，可用原消息 ID 核对。';
export function MainChatDialog({project,onClose}:{project:ProjectView;onClose:()=>void}){
 const dialog=useRef<HTMLDialogElement>(null),alive=useRef(true),pending=useRef(false),unconfirmed=useRef<MainChatInput|undefined>(undefined);
 const entries=useRef<HTMLDivElement>(null);
 const submittedDraft=useRef(false);
 const [view,setView]=useState<MainChatView>(),[text,setText]=useState(''),[selected,setSelected]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState<string>(),[uncertain,setUncertain]=useState(false);
 useEffect(()=>{const node=entries.current;if(node)node.scrollTop=node.scrollHeight;},[view?.messages.at(-1)?.messageId]);
 async function refresh(){if(pending.current)return;pending.current=true;setBusy(true);try{const result=await value(window.personalAgent.readMainChat({projectId:project.id}));if(alive.current){setView(result);setError(undefined);}}catch{if(alive.current)setError('暂时无法读取主聊天，请刷新重试。');}finally{pending.current=false;if(alive.current)setBusy(false);}}
 useEffect(()=>{alive.current=true;dialog.current!.showModal();void refresh();return()=>{alive.current=false;dialog.current?.close();};},[project.id]);
 async function submit(input?:MainChatInput){if(pending.current||!view)return;const clearsDraft=input?false:unconfirmed.current?submittedDraft.current:true;submittedDraft.current=clearsDraft;const message=input??unconfirmed.current??{projectId:project.id,messageId:crypto.randomUUID(),text,focusRevision:view.focusRevision,...(selected?{taskId:selected}:{})};unconfirmed.current=message;pending.current=true;setBusy(true);setError(undefined);
  try{const result=await value(window.personalAgent.submitMainChat(message));if(alive.current){setView(result);if(clearsDraft)setText(current=>current===message.text?'':current);setUncertain(false);unconfirmed.current=undefined;}}
  catch(e){if(alive.current){setError(errorText(e));setUncertain(true);if(e instanceof Error&&/FOCUS_CHANGED|CANDIDATE|CLARIFICATION/.test(e.message)){unconfirmed.current=undefined;setUncertain(false);try{setView(await value(window.personalAgent.readMainChat({projectId:project.id})));}catch{}}}}
  finally{pending.current=false;if(alive.current)setBusy(false);}
 }
 return <dialog ref={dialog} className="skills-dialog main-chat-dialog" aria-label="主聊天" onCancel={e=>{e.preventDefault();onClose();}}><div className="skills-dialog-actions"><button data-action="close-main-chat" onClick={onClose}>返回工作区</button></div><section data-main-chat>
 <div className="history-heading"><h2>主聊天</h2><button className="secondary" data-action="refresh-main-chat" disabled={busy} onClick={()=>void refresh()}>刷新记录</button></div>
 <p className="history-note">输入 /query 直接查询，/note 保存讨论。模型提案与逐项操作可在下方展开；任务变更需要明确提交提案。</p>
 <p className="history-note" data-chat-focus>{view?.focus?`当前讨论：${view.focus.task.title} · ${view.focus.task.taskId.slice(-6)}`:'尚未确定讨论任务'}</p>
 {error&&<p className="notice error" role="alert" data-chat-error>{error}</p>}
 <div className="main-chat-entries" ref={entries}>{view?.messages.map(m=><article className="skill-card" key={m.messageId} data-chat-message={m.messageId} data-chat-kind={m.kind}><small>{new Date(m.createdAt).toLocaleString()}</small><p className="chat-user-text" data-chat-user-text>{m.text}</p>{m.truncated&&<small>内容过长，仅显示部分记录。</small>}{m.kind==='query'&&m.task?<p data-chat-task-result>查询快照：{m.task.title} · {statusName[m.task.status]??m.task.status}。这是上次查询时的状态。</p>:m.kind==='clarify'?<p>需要明确查询对象或使用受支持的查询指令。</p>:<p>讨论记录已保存，尚未由模型回答。</p>}</article>)}</div>
 {view?.truncated&&<p className="history-note">仅显示近期记录或部分文本。</p>}
 <div className="main-chat-pendings">{view?.pending.map(p=><section className="skill-card" key={p.id} data-chat-pending={p.id}><strong>选择这个问题的查询任务</strong><p className="history-note">此选择只回答对应问题，不开始执行。</p>{p.choices.length?p.choices.map(c=><button className="secondary" data-chat-choice={c.taskId} key={c.taskId} disabled={busy||uncertain} onClick={()=>void submit({projectId:project.id,messageId:crypto.randomUUID(),text:'/query',focusRevision:view.focusRevision,pendingInteractionId:p.id,taskId:c.taskId})}>{c.title} · {c.taskId.slice(-6)}</button>):<p>候选任务为空或已变化，请重新查询。</p>}</section>)}</div>
 <label>明确引用任务<select data-chat-task-select value={selected} disabled={busy||uncertain} onChange={e=>setSelected(e.target.value)}><option value="">使用明确引用或当前讨论任务</option>{view?.tasks.map(t=><option key={t.taskId} value={t.taskId}>{t.title} · {t.taskId.slice(-6)}</option>)}</select></label>
 <textarea aria-label="主聊天输入" data-chat-draft value={text} maxLength={8192} disabled={busy||uncertain} onChange={e=>setText(e.target.value)} rows={3} placeholder="例如：/query，或 /note 记录讨论内容"/>
 <button data-action="send-main-chat" disabled={busy||!view||(!uncertain&&!text.trim())} onClick={()=>void submit()}>{busy?'正在保存…':uncertain?'核对本次消息':'发送'}</button>
 <ChatRoutePanel project={project} taskId={selected||undefined} focusRevision={view?.focusRevision} onProposed={()=>void refresh()}/>
 </section></dialog>;
}
