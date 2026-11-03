import {test} from 'node:test';
import assert from 'node:assert/strict';
import {routeMainChat} from '../packages/runtime/src/chat-router.ts';

// Public in-memory metadata fixtures, not model decisions or task execution.
const tasks=[{taskId:'task-a',title:'修复登录'},{taskId:'task-b',title:'Public report'},{taskId:'task-c',title:'重复标题'},{taskId:'task-d',title:'重复标题'}];

test('explicit query command requires a single known object, without a global-query fallback',()=>{
  assert.deepEqual(routeMainChat('/query task-a',tasks),{kind:'query',taskId:'task-a',candidates:['task-a'],reason:'explicit_text_task'});
  assert.equal(routeMainChat('/query #task-b',tasks).taskId,'task-b');
  assert.equal(routeMainChat('/query',tasks,undefined,'task-a').taskId,'task-a');
  assert.deepEqual(routeMainChat('/query',tasks),{kind:'clarify',candidates:tasks.map(t=>t.taskId),reason:'task_reference_required'});
  assert.deepEqual(routeMainChat('/query',[]),{kind:'clarify',candidates:[],reason:'task_reference_required'});
  for(const text of ['/query task-missing','/query #missing'])assert.equal(routeMainChat(text,tasks,undefined,'task-a').reason,'unknown_task');
  for(const text of ['/query task-a task-b','/query task-a cancel','/run task-a','/QUERY task-a'])assert.equal(routeMainChat(text,tasks,undefined,'task-a').kind,'clarify');
});
test('UI object, explicit text ID, valid Focus and unique title have deterministic priority',()=>{
  assert.equal(routeMainChat('查询 #task-b 状态',tasks,'task-a','task-c').taskId,'task-a');
  assert.equal(routeMainChat('查询 #task-b 状态',tasks,undefined,'task-a').taskId,'task-b');
  assert.equal(routeMainChat('Public report status',tasks,undefined,'task-a').taskId,'task-a');
  assert.equal(routeMainChat('Public report status',tasks,undefined,'missing').taskId,'task-b');
  assert.equal(routeMainChat('修复登录的进展怎么样',tasks).taskId,'task-a');
  assert.equal(routeMainChat('task-b status',tasks).taskId,'task-b');
  assert.equal(routeMainChat('Task ID: task-b progress',tasks).taskId,'task-b');
});
test('Chinese and English state questions remain read-only and require an object',()=>{
  for(const text of ['状态怎么样','进展如何','完成了吗','what is the status?','progress please','How is it going?','Is it done?']){
    assert.equal(routeMainChat(text,tasks,undefined,'task-a').kind,'query',text);
    assert.equal(routeMainChat(text,tasks).kind,'clarify',text);
  }
});
test('duplicate titles and multiple IDs clarify rather than silently choosing a task',()=>{
  assert.deepEqual(routeMainChat('查询重复标题状态',tasks),{kind:'clarify',candidates:['task-c','task-d'],reason:'ambiguous_title'});
  assert.equal(routeMainChat('status #task-a and #task-b',tasks,'task-c','task-d').reason,'multiple_task_references');
  assert.equal(routeMainChat('status #task-a #task-a',tasks).taskId,'task-a');
});
test('unknown explicit IDs never fall back to UI selection, Focus or a matching title',()=>{
  for(const text of ['查询 #missing 状态','status task-missing','Task ID: absent status','status 00000000-0000-0000-0000-000000000000','status #../private/path','status #','Task ID: /private/path status']){
    const routed=routeMainChat(text,tasks,'task-a','task-b');assert.equal(routed.kind,'clarify');assert.equal(routed.reason,'unknown_task');assert.equal(routed.taskId,undefined);assert.equal(JSON.stringify(routed).includes('missing'),false);
  }
  assert.equal(routeMainChat('status',tasks,'absent','task-a').reason,'unknown_task');
});
test('selected objects do not turn actions or mixed query/action language into queries',()=>{
  for(const text of ['取消','暂停 task-a','创建一个任务','继续','恢复','重发','查询状态然后取消','cancel task-a','pause','create task','resume','continue','stop','status then delete task-a','send it','run task-a']){
    const routed=routeMainChat(text,tasks,'task-a','task-b');assert.equal(routed.kind,'clarify',text);assert.equal(routed.reason,'action_requires_explicit_command');assert.equal(routed.taskId,undefined);
  }
});
test('explicit note body stays inert and unknown text never invokes a model or changes Focus',()=>{
  for(const text of ['/note 取消 #missing 并创建任务','/note\n<script>Public text</script>','hello there','task-a','<img src=x onerror=alert(1)>','/note status #task-b']){
    assert.deepEqual(routeMainChat(text,tasks,'task-a','task-b'),{kind:'note',candidates:[],reason:'model_not_connected'});
  }
  assert.equal(routeMainChat('/note',tasks).reason,'note_body_required');
  assert.equal(routeMainChat('/note   ',tasks).reason,'note_body_required');
});
test('exact IDs do not match prefixes, case aliases or normalized paths',()=>{
  assert.equal(routeMainChat('status #task-ab',tasks,undefined,'task-a').reason,'unknown_task');
  assert.equal(routeMainChat('status #TASK-A',tasks,undefined,'task-a').reason,'unknown_task');
  assert.equal(routeMainChat('/query ../task-a',tasks,undefined,'task-b').kind,'clarify');
  assert.equal(routeMainChat('Public reporter status',tasks).kind,'clarify');
  assert.equal(routeMainChat('status of Public report',tasks).taskId,'task-b');
});
test('candidate output is bounded and contains only supplied identifiers',()=>{
  const many=Array.from({length:25},(_,i)=>({taskId:'public-'+i,title:'同名'}));
  for(const text of ['/query','查询同名状态']){const routed=routeMainChat(text,many);assert.equal(routed.kind,'clarify');assert.deepEqual(routed.candidates,many.slice(0,20).map(t=>t.taskId));}
});
test('malformed and oversized inputs return fixed errors without private diagnostic content',()=>{
  const invalidTexts:unknown[]=[null,{},1,'','  ','x'.repeat(32769),'private\0path'];
  for(const text of invalidTexts)assert.deepEqual(routeMainChat(text as string,tasks),{kind:'clarify',candidates:[],reason:'invalid_input'});
  const invalidTasks:unknown[]=[null,{},[null],[{taskId:'/private/path',title:'x'}],[{taskId:'x',title:null}],[{taskId:'x',title:''}],[{taskId:'x',title:'x'.repeat(1001)}],[{taskId:'x',title:'a\0b'}],[{taskId:'x',title:'a'},{taskId:'x',title:'b'}],new Array(10001).fill(tasks[0])];
  for(const input of invalidTasks)assert.deepEqual(routeMainChat('status',input as typeof tasks),{kind:'clarify',candidates:[],reason:'invalid_input'});
  assert.equal(routeMainChat('status',tasks,'/private/path').reason,'invalid_input');
  assert.equal(routeMainChat('status',tasks,undefined,{} as string).reason,'invalid_input');
});
test('legal multiline and tabbed Task titles do not poison another explicit Task query',()=>{
  const existing=[...tasks,{taskId:'multiline',title:'Public first line\nSecond line\twith tab\r\nLast line'}];
  assert.deepEqual(routeMainChat('/query',existing,'task-a'),{kind:'query',taskId:'task-a',candidates:['task-a'],reason:'explicit_ui_task'});
  assert.equal(routeMainChat('/query multiline',existing).taskId,'multiline');
  assert.equal(routeMainChat('状态',existing,'multiline').taskId,'multiline');
  assert.equal(routeMainChat('Public first line\nSecond line\twith tab\r\nLast line status',existing).taskId,'multiline');
});
test('routing does not mutate or read extra candidate data, and emits no title/body/path',()=>{
  const candidate={taskId:'public-id',title:'Public title'};
  Object.defineProperty(candidate,'directory',{get(){throw Error('PRIVATE_PATH_READ');}});
  const frozen=Object.freeze([Object.freeze(candidate)]);
  const routed=routeMainChat('Public title status',frozen as unknown as typeof tasks);
  assert.deepEqual(routed,{kind:'query',taskId:'public-id',candidates:['public-id'],reason:'unique_title'});
  assert.equal(JSON.stringify(routed).includes('Public title'),false);
  routed.candidates.push('mutation');assert.equal(routeMainChat('Public title status',frozen as unknown as typeof tasks).candidates.length,1);
});
