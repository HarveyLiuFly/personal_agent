import React,{useEffect,useRef,useState} from 'react';
import type {ProjectView,HostResult} from '../../../packages/contracts/src/views.ts';
import type {TaskSummary} from '../../../packages/contracts/src/tasks.ts';
import type {ChatRouteView,ProposeMainChat,CommitChatRoute,RouteStep} from '../../../packages/contracts/src/routing.ts';

interface Props {project:ProjectView;taskId?:string;focusRevision?:number;onProposed?:(route:ChatRouteView)=>void}
type Correction={projectId:string;planId:string;taskId:string;messageId:string;focusRevision:number};
type Unconfirmed={kind:'propose';input:ProposeMainChat}|{kind:'commit';input:CommitChatRoute}|{kind:'correct';input:Correction};
const names:Record<string,string>={CHAT:'回答讨论',CREATE_TASK:'加入待办',CONTINUE_TASK:'续接任务',UPDATE_TASK:'修改任务标题',QUERY_TASK:'查看任务',PAUSE_TASK:'暂停任务',CANCEL_TASK:'取消任务',CREATE_GOAL:'创建长期目标',CLARIFY:'澄清问题'};
const states:Record<string,string>={prepared:'提案尚未启动',proposing:'模型正在拟定提案',proposed:'等待确认操作',committing:'正在逐项处理',completed:'本提案已处理',failed:'有操作未完成',outcome_unknown:'结果待核对',corrected:'已更正归属',pending:'等待前置操作',executing:'处理中',cancelled:'已取消'};
const taskStates:Record<string,string>={created:'待处理',queued:'排队中',running:'执行中',waiting_input:'等待补充',waiting_approval:'等待批准',waiting_trigger:'等待触发',paused:'已暂停',needs_review:'待审查',completed:'已完成',failed:'失败',cancelled:'已取消',outcome_unknown:'结果待核对'};
async function value<T>(promise:Promise<HostResult<T>>):Promise<T>{const result=await promise;if(!result.ok)throw Error(result.errorCode);return result.value;}
const definitive=(code:string)=>/^(?:CHAT_FOCUS_CHANGED|ROUTE_VERSION_CHANGED|ROUTE_CANDIDATE_CHANGED|ROUTE_CONTEXT_CHANGED|CORRECTION_REQUIRES_RECONCILIATION|ROUTE_PLAN_UNAVAILABLE|ROUTE_PROJECT_MISMATCH|ROUTE_TASK_NOT_CANDIDATE|TASK_AUTHORIZATION_CHANGED|INVALID_ROUTE_(?:INPUT|COMMIT|CORRECTION)|IDEMPOTENCY_CONFLICT)$/.test(code);
function failure(error:unknown):string {
 const code=error instanceof Error?error.message:'';
 if(/FOCUS_CHANGED/.test(code))return'讨论对象已变化。本次请求未提交，请刷新并重新确认对象。';
 if(/VERSION_CHANGED|CANDIDATE_CHANGED|CONTEXT_CHANGED|AUTHORIZATION_CHANGED/.test(code))return'任务或来源已变化。本次请求未提交，请刷新并重新检查提案。';
 if(code==='CORRECTION_REQUIRES_RECONCILIATION')return'仍有执行中或结果未知的操作，请先核对；更正归属不会撤回已经发生的结果。';
 if(code==='RUNTIME_BUSY')return'执行器正忙。本次提案可使用原消息再次核对，不会自动另发请求。';
 if(definitive(code))return'本次请求已被拒绝，请刷新记录后重新确认。';
 return'本次请求尚未确认。请核对原请求；不会自动另发模型请求或重做操作。';
}
function summary(step:RouteStep):string|undefined {
 if(step.state!=='completed')return undefined;
 if(step.operation.kind==='CHAT'||step.operation.kind==='CLARIFY')return step.result;
 if(step.receipt)return'任务'+(taskStates[step.receipt.status]??'状态已更新')+'。';
 try{const result=JSON.parse(step.result??'null') as Record<string,unknown>|null;if(!result)return undefined;
  if(step.operation.kind==='QUERY_TASK')return'查询快照：'+String(result.title??'任务')+' · '+(taskStates[String(result.status)]??String(result.status??'待核对'))+'。这是查询当时的状态。';
  if(step.operation.kind==='CREATE_GOAL')return'已创建目标「'+String(result.title??'长期目标')+'」，后续计划需另行确认。';
  if(step.operation.kind==='CONTINUE_TASK')return'本轮执行已结束；任务'+(taskStates[String(result.taskStatus)]??'状态待核对')+'。';
 }catch{/* Results remain inert text, never interpreted as markup or commands. */}
 return undefined;
}

/** Separate draft from rules-only chat. Polling reads existing records; every
 * inference, commit and correction requires its own explicit user click.
 */
export function ChatRoutePanel({project,taskId,focusRevision,onProposed}:Props){
 const alive=useRef(true),scope=useRef(project.id),reading=useRef(false),mutating=useRef(false),unconfirmed=useRef<Unconfirmed|undefined>(undefined);
 const [routes,setRoutes]=useState<ChatRouteView[]>([]),[tasks,setTasks]=useState<TaskSummary[]>([]),[text,setText]=useState(''),[selected,setSelected]=useState(taskId??''),[revision,setRevision]=useState(focusRevision??0),[loaded,setLoaded]=useState(false),[busy,setBusy]=useState(false),[uncertain,setUncertain]=useState(false),[error,setError]=useState<string>(),[corrections,setCorrections]=useState<Record<string,string>>({});
 const callback=useRef(onProposed);callback.current=onProposed;
 function notify(route:ChatRouteView){try{callback.current?.(route);}catch{/* A confirmed Host result stays confirmed if a parent refresh fails. */}}
 function merge(incoming:ChatRouteView[]){setRoutes(current=>incoming.map(route=>{const newer=current.find(old=>old.id===route.id&&old.version>route.version);return newer??route;}));}
 function accepted(request:Unconfirmed,route:ChatRouteView){
  unconfirmed.current=undefined;setUncertain(false);setError(undefined);
  if(request.kind==='propose'){setText(current=>current===request.input.text?'':current);notify(route);}
  else if(request.kind==='correct')notify(route);
 }
 async function refresh(){
  if(reading.current)return;reading.current=true;const projectId=project.id;
  try{const [current,chat]=await Promise.all([value(window.personalAgent.listChatRoutes({projectId})),value(window.personalAgent.readMainChat({projectId}))]);if(!alive.current||scope.current!==projectId)return;
   merge(current);setTasks(chat.tasks);setRevision(chat.focusRevision);setLoaded(true);
   const pending=unconfirmed.current;if(pending&&!mutating.current){
    const found=current.find(route=>pending.kind==='propose'?route.messageId===pending.input.messageId:route.id===pending.input.planId);
    const correctionSaved=pending.kind==='correct'&&chat.messages.some(message=>message.messageId===pending.input.messageId&&message.reason==='user_correction'&&message.task?.taskId===pending.input.taskId);
    if(found&&((pending.kind==='propose'&&found.routingRunId!==null)||(pending.kind==='commit'&&['committing','completed','failed','outcome_unknown'].includes(found.state))||correctionSaved))accepted(pending,found);
   }
  }catch{if(alive.current&&scope.current===projectId)setError(current=>current??'暂时无法读取提案。刷新只核对记录，不会启动模型或提交操作。');}finally{reading.current=false;}
 }
 useEffect(()=>{alive.current=true;if(scope.current!==project.id){scope.current=project.id;unconfirmed.current=undefined;setRoutes([]);setTasks([]);setText('');setSelected(taskId??'');setRevision(focusRevision??0);setUncertain(false);setError(undefined);setCorrections({});setBusy(mutating.current);}setLoaded(false);void refresh();const timer=setInterval(()=>void refresh(),1500);return()=>{alive.current=false;clearInterval(timer);};},[project.id]);
 async function execute(request:Unconfirmed){
  if(mutating.current)return;mutating.current=true;unconfirmed.current=request;setBusy(true);setError(undefined);const projectId=project.id;
  try{const route=await value(request.kind==='propose'?window.personalAgent.proposeMainChat(request.input):request.kind==='commit'?window.personalAgent.commitChatRoute(request.input):window.personalAgent.correctChatRoute(request.input));if(!alive.current||scope.current!==projectId)return;setRoutes(current=>{const other=current.filter(item=>item.id!==route.id);return[route,...other];});accepted(request,route);}
  catch(cause){if(alive.current&&scope.current===projectId){setError(failure(cause));if(cause instanceof Error&&definitive(cause.message)){unconfirmed.current=undefined;setUncertain(false);}else setUncertain(true);}}
  finally{mutating.current=false;if(alive.current&&scope.current===projectId){setBusy(false);void refresh();}}
 }
 function propose(){if(!loaded||!text.trim()||unconfirmed.current)return;void execute({kind:'propose',input:{projectId:project.id,messageId:crypto.randomUUID(),text,focusRevision:revision,...(selected?{taskId:selected}:{})}});}
 const blocked=busy||uncertain;
 return <details data-chat-route-panel style={{flexShrink:0,maxHeight:'50vh',overflowY:'auto'}}><summary>模型提案与多项操作</summary><div className="skill-card">
  <h3>先审阅提案，再确认操作</h3><p className="history-note">生成提案会调用模型。选择任务仅指定讨论对象；创建、修改、暂停或续接等动作会列在提案中，确认后才逐项处理。查询不会另建任务。</p>
  <label>提案引用任务<select data-route-task-select value={selected} disabled={blocked} onChange={event=>setSelected(event.target.value)}><option value="">由明确引用或当前讨论确定</option>{tasks.map(task=><option key={task.taskId} value={task.taskId}>{task.title} · {task.taskId.slice(-6)}</option>)}</select></label>
  <label>模型提案输入<textarea data-route-draft aria-label="模型提案输入" value={text} onChange={event=>setText(event.target.value)} maxLength={8192} disabled={blocked} rows={3} placeholder="例如：查询任务进展，并把另一项任务加入待办"/></label>
  <button data-action="propose-main-route" disabled={blocked||!loaded||!text.trim()} onClick={propose}>生成模型提案</button>{' '}<button className="secondary" data-action="refresh-main-routes" disabled={busy} onClick={()=>void refresh()}>核对提案记录</button>
  {uncertain&&<button className="secondary" data-action="retry-main-route" disabled={busy} onClick={()=>{const request=unconfirmed.current;if(request)void execute(request);}}>使用原请求核对</button>}
  {error&&<p className="notice error" role="alert" data-route-error>{error}</p>}
  <div data-route-records style={{maxHeight:'32vh',overflowY:'auto'}}>{!routes.length&&loaded?<p className="history-note">还没有模型提案。</p>:routes.map(route=><article className="skill-card" key={route.id} data-route-id={route.id} data-route-state={route.state}>
   <strong>{states[route.state]??'待核对'}</strong><small> · {new Date(route.createdAt).toLocaleString()}</small>
   {route.state==='prepared'&&<p>提案请求已记录。请使用原请求核对，尚未确认模型已经启动。</p>}
   {route.state==='proposing'&&<p>正在等待这一次模型提案。读取进展不会再次请求模型。</p>}
   {route.plan?.question&&<p data-route-question>{route.plan.question}</p>}
   <ol>{route.steps.map(step=><li key={step.index} data-route-step-index={step.index} data-route-step-state={step.state}><p><strong>{step.index+1}. {names[step.operation.kind]??'待核对操作'}</strong> · {states[step.state]??'待核对'}{step.operation.taskId&&' · 任务 '+step.operation.taskId.slice(-6)}</p>{step.operation.dependsOn.length>0&&<p className="history-note">前置操作：{step.operation.dependsOn.map(index=>index+1).join('、')}</p>}{step.operation.title&&<p>新标题：{step.operation.title}</p>}{step.operation.text&&<p>{step.operation.text}</p>}{summary(step)&&<p data-route-result>{summary(step)}</p>}{step.state==='outcome_unknown'&&<p>本项结果未知，不会自动重发；请先核对已经发生的结果。</p>}{step.state==='failed'&&<p>本项未完成，依赖它的后续操作会停止；独立操作分别记录结果。</p>}</li>)}</ol>
   {route.state==='proposed'&&<><p className="history-note">请逐项检查对象、动作和前置关系。确认仅提交这份提案；新任务先进入待办，续接任务可能实际调用模型。</p><button data-action="commit-main-route" disabled={blocked} onClick={()=>void execute({kind:'commit',input:{projectId:project.id,planId:route.id,expectedVersion:route.version}})}>确认这份提案的操作</button></>}
   {route.state==='outcome_unknown'&&<p className="notice">已有结果待核对，不会整组重做。请在任务活动中检查原有执行。</p>}
   {['proposed','committing','completed','failed','corrected'].includes(route.state)&&<div><label>更正为明确任务<select data-route-correction-target={route.id} disabled={blocked||route.steps.some(step=>['executing','outcome_unknown'].includes(step.state))} value={corrections[route.id]??''} onChange={event=>setCorrections(current=>({...current,[route.id]:event.target.value}))}><option value="">请选择更正后的任务</option>{tasks.map(task=><option key={task.taskId} value={task.taskId}>{task.title} · {task.taskId.slice(-6)}</option>)}</select></label><p className="history-note">更正会停止这份提案尚未派发的操作，并更新讨论对象；已经发生的结果会保留。</p><button className="secondary" data-action="correct-main-route" disabled={blocked||!corrections[route.id]||route.steps.some(step=>['executing','outcome_unknown'].includes(step.state))} onClick={()=>void execute({kind:'correct',input:{projectId:project.id,planId:route.id,taskId:corrections[route.id]!,messageId:crypto.randomUUID(),focusRevision:revision}})}>确认更正归属</button></div>}
  </article>)}</div>
 </div></details>;
}
