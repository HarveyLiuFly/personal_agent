import {createHash} from 'node:crypto';
import {routeKinds} from '../../contracts/src/routing.ts';
import type {RoutePlan,RouteOperation} from '../../contracts/src/routing.ts';
import {LedgerError} from '../../store/src/ledger.ts';
import type {TaskSummary} from '../../contracts/src/tasks.ts';
const digest=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const object=(x:unknown):x is Record<string,unknown>=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const exact=(x:Record<string,unknown>,keys:string[])=>Object.keys(x).length===keys.length&&keys.every(k=>Object.hasOwn(x,k));
const nullable=(x:unknown,max:number)=>x===null||typeof x==='string'&&x.length<=max&&!x.includes('\0');
export const routeOutputSchema={type:'object',additionalProperties:false,properties:{operations:{type:'array',minItems:1,maxItems:10,items:{type:'object',additionalProperties:false,properties:{kind:{type:'string',enum:[...routeKinds]},taskId:{type:['string','null']},text:{type:['string','null']},title:{type:['string','null']},dependsOn:{type:'array',items:{type:'integer'}}},required:['kind','taskId','text','title','dependsOn']}},focusTaskId:{type:['string','null']},question:{type:['string','null']}},required:['operations','focusTaskId','question']};
/** Candidate-bound model proposals; no authority, RPC, file or task side effect is present here. */
export function validateRoutePlan(raw:unknown,candidates:TaskSummary[]):RoutePlan{
 let value=raw;if(typeof raw==='string'){if(raw.length>32768)throw new LedgerError('ROUTE_OUTPUT_TOO_LARGE');try{value=JSON.parse(raw);}catch{throw new LedgerError('INVALID_ROUTE_JSON');}}
 if(!object(value)||!exact(value,['operations','focusTaskId','question'])||!Array.isArray(value.operations)||!value.operations.length||value.operations.length>10||!nullable(value.focusTaskId,200)||!nullable(value.question,1000))throw new LedgerError('INVALID_ROUTE_PLAN');
 const ids=new Set(candidates.map(c=>c.taskId));if(value.focusTaskId!==null&&!ids.has(String(value.focusTaskId)))throw new LedgerError('ROUTE_TASK_NOT_CANDIDATE');
 const operations=value.operations.map((op:unknown,index:number)=>{
  if(!object(op)||!exact(op,['kind','taskId','text','title','dependsOn'])||!routeKinds.includes(op.kind as RouteOperation['kind'])||!nullable(op.taskId,200)||!nullable(op.text,8192)||!nullable(op.title,120)||!Array.isArray(op.dependsOn)||op.dependsOn.length>10||op.dependsOn.some(i=>!Number.isInteger(i)||i<0||i>=index)||new Set(op.dependsOn).size!==op.dependsOn.length)throw new LedgerError('INVALID_ROUTE_OPERATION');
  const kind=op.kind as RouteOperation['kind'];if(['CONTINUE_TASK','UPDATE_TASK','QUERY_TASK','PAUSE_TASK','CANCEL_TASK'].includes(kind)){if(typeof op.taskId!=='string'||!ids.has(op.taskId))throw new LedgerError('ROUTE_TASK_NOT_CANDIDATE');}else if(op.taskId!==null)throw new LedgerError('INVALID_ROUTE_TARGET');
  if(['CREATE_TASK','CREATE_GOAL','CONTINUE_TASK','CHAT'].includes(kind)&&(typeof op.text!=='string'||!op.text.trim()))throw new LedgerError('ROUTE_TEXT_REQUIRED');if(kind==='UPDATE_TASK'&&(typeof op.title!=='string'||!op.title.trim()))throw new LedgerError('ROUTE_TITLE_REQUIRED');
  return op as unknown as RouteOperation;
 });
 if(operations.some(o=>o.kind==='CLARIFY')&&(operations.length!==1||!value.question))throw new LedgerError('INVALID_ROUTE_CLARIFICATION');
 return{operations,focusTaskId:value.focusTaskId as string|null,question:value.question as string|null};
}
export function routePrompt(text:string,candidates:TaskSummary[],focusTaskId:string|null){return JSON.stringify({request:text,candidates:candidates.map(t=>({taskId:t.taskId,title:t.title,status:t.status,version:t.version})),focusTaskId,notice:'Return only a JSON proposal. Never execute. Query is not task creation. Unknown or ambiguous objects require CLARIFY. Existing Task IDs must come from candidates. Proposed tasks are queued until a separate Host command starts them. You only route; never answer a CHAT request yourself. CHAT.text must forward the user request to the separate Chat role. Personal memory is intentionally absent from Router context; the Chat role resolves confirmed personal memory, so that absence is not a reason to clarify. A request for conversation or a personal-memory answer should produce one CHAT operation. CLARIFY is reserved for ambiguous action or task identity, must be the only operation and requires a nonempty question. Never combine CLARIFY with CHAT or any other operation.'});}
export const isRejectedRouteOutput=(code:unknown):boolean=>typeof code==='string'&&/^(?:INVALID_ROUTE_(?:JSON|PLAN|OPERATION|TARGET|CLARIFICATION)|ROUTE_(?:OUTPUT_TOO_LARGE|TASK_NOT_CANDIDATE|TEXT_REQUIRED|TITLE_REQUIRED))$/.test(code);
export const routeSchemaHash=digest(routeOutputSchema);
