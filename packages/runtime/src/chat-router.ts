export interface MainChatTask {taskId:string;title:string}
export interface MainChatRoute {
  kind:'query'|'clarify'|'note';
  taskId?:string;
  candidates:string[];
  /** Fixed diagnostic code; never contains message text, titles or paths. */
  reason:string;
}

const idPattern=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const controls=/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
const action=/(?:暂停|取消|停止|终止|结束|关掉|创建|新建|续接|继续|恢复|启动|执行|派工|安排|删除|删掉|重试|重发|修改|更新|批准|拒绝|发送|提交|保存|运行)|\b(?:pause|cancel|stop|kill|create|resume|continue|start|restart|execute|dispatch|schedule|delete|retry|resend|modify|update|approve|reject|send|submit|save|run)\b/i;
const query=/(?:状态|进度|进展|完成了吗|完成了没|怎么样|查询|查看|现在如何|是否完成)|\b(?:status|progress)\b|\bhow\s+(?:is|are)\b.*\b(?:going|doing)\b|\bis\b.*\b(?:done|complete|finished)\b/i;
const result=(kind:MainChatRoute['kind'],reason:string,candidates:string[]=[],taskId?:string):MainChatRoute=>taskId===undefined?{kind,candidates:candidates.slice(0,20),reason}:{kind,taskId,candidates:candidates.slice(0,20),reason};

/** Deterministic, read-only routing. Context selects an object, never an action.
 * Inputs must already be scoped by the Host. This function grants no authority,
 * changes no Focus and does not read files, call a model or dispatch work.
 */
export function routeMainChat(text:string,tasks:MainChatTask[],explicitTaskId?:string,focusTaskId?:string):MainChatRoute {
  if(typeof text!=='string'||text.length===0||text.length>32768||controls.test(text)||!text.trim()||!Array.isArray(tasks)||tasks.length>10000)return result('clarify','invalid_input');
  const byId=new Map<string,MainChatTask>();
  for(const task of tasks){
    // Existing Task titles are user text and may contain newlines or tabs.
    if(!task||typeof task!=='object'||Array.isArray(task)||typeof task.taskId!=='string'||!idPattern.test(task.taskId)||typeof task.title!=='string'||!task.title.trim()||task.title.length>1000||controls.test(task.title)||byId.has(task.taskId))return result('clarify','invalid_input');
    byId.set(task.taskId,task);
  }
  if((explicitTaskId!==undefined&&(typeof explicitTaskId!=='string'||!idPattern.test(explicitTaskId)))||(focusTaskId!==undefined&&(typeof focusTaskId!=='string'||!idPattern.test(focusTaskId))))return result('clarify','invalid_input');
  const input=text.trim(),all=[...byId.keys()];
  // A note's body is inert, including command-like words and references.
  if(/^\/note(?:\s|$)/.test(input))return /^\/note\s+\S/.test(input)?result('note','model_not_connected'):result('clarify','note_body_required');
  let commandId:string|undefined,command=false;
  if(input.startsWith('/')){
    const match=/^\/query(?:\s+(#?[A-Za-z0-9][A-Za-z0-9._:-]{0,199}))?$/.exec(input);
    if(!match)return result('clarify','unsupported_command');
    command=true;commandId=match[1]?.replace(/^#/,'');
  }else{
    // Reject action language before applying any selected object or Focus.
    if(action.test(input))return result('clarify','action_requires_explicit_command');
    if(!query.test(input))return result('note','model_not_connected');
  }
  const references=new Set<string>(),unknown=new Set<string>();
  if(commandId!==undefined)(byId.has(commandId)?references:unknown).add(commandId);
  if(!command){
    // Exact ASCII identifier tokens do not match ID prefixes or normalize IDs.
    for(const token of input.match(/[A-Za-z0-9][A-Za-z0-9._:-]*/g)??[])if(byId.has(token))references.add(token);
    // Hash references, labelled IDs and UUID/task-ID forms are explicit even
    // when unknown, so they can never silently fall back to an old Focus.
    const stated=[...input.matchAll(/#([^\s#]*)/g),...input.matchAll(/\btask(?:\s+id)?\s*[:=]\s*#?([^\s]*)/gi)];
    for(const match of stated){const id=match[1]!;(byId.has(id)?references:unknown).add(id);}
    for(const token of input.match(/[A-Za-z0-9][A-Za-z0-9._:-]*/g)??[])if(/^(?:task[-_:].+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.test(token)&&!byId.has(token))unknown.add(token);
  }
  if(unknown.size)return result('clarify','unknown_task',[...references]);
  if(references.size>1)return result('clarify','multiple_task_references',[...references]);
  if(explicitTaskId!==undefined){
    if(!byId.has(explicitTaskId))return result('clarify','unknown_task');
    return result('query','explicit_ui_task',[explicitTaskId],explicitTaskId);
  }
  const reference=[...references][0];
  if(reference!==undefined)return result('query','explicit_text_task',[reference],reference);
  if(focusTaskId!==undefined&&byId.has(focusTaskId))return result('query','focused_task',[focusTaskId],focusTaskId);
  if(!command){
    const matched=tasks.filter(task=>{
      // An ASCII title is a phrase, never an arbitrary substring of a word.
      const escaped=task.title.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
      return new RegExp((/^[A-Za-z0-9_]/.test(task.title)?'(?<![A-Za-z0-9_])':'')+escaped+(/[A-Za-z0-9_]$/.test(task.title)?'(?![A-Za-z0-9_])':'')).test(input);
    });
    if(matched.length===1){const id=matched[0]!.taskId;return result('query','unique_title',[id],id);}
    if(matched.length>1)return result('clarify','ambiguous_title',matched.map(task=>task.taskId));
  }
  return result('clarify','task_reference_required',all);
}
