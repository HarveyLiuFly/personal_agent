import {readFileSync,writeFileSync,mkdirSync,mkdtempSync,realpathSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {ExecutionLedger} from '../packages/store/src/ledger.ts';
import {ForegroundExecution} from '../packages/runtime/src/execution.ts';
import {ChatRouteService} from '../packages/runtime/src/chat-routes.ts';
import {TaskService} from '../packages/runtime/src/tasks.ts';
import {routeRoleProfile} from '../packages/runtime/src/route-profile.ts';
import {verifiedCodex} from '../packages/codex-adapter/src/binary.ts';
const root=resolve('.'),marker=join(root,'.local/M3-native-route-state.json');mkdirSync(join(root,'.local'),{recursive:true});
if(existsSync(marker))throw Error('NATIVE_PROBE_ALREADY_RECORDED_NO_AUTOMATIC_RESEND');
const state=realpathSync(mkdtempSync(join(root,'.local/m3-native-route-'))),cwd=join(state,'workspace');mkdirSync(cwd);writeFileSync(marker,JSON.stringify({state})+'\n',{flag:'wx',mode:0o600});
const store=new ExecutionLedger(join(state,'ledger.db'),readFileSync(join(root,'docs/design/contracts/schema.sql'),'utf8'));store.startOwner('m3-native-router',true);const project=store.registerWorkspace(cwd,cwd);
const task=store.taskCommand({kind:'create',projectId:project.id,commandKey:'public-route-task',text:'PUBLIC_ROUTER_TASK'}),execution=new ForegroundExecution(store,{executable:verifiedCodex(root).executable,stateDirectory:join(state,'codex-state'),timeoutMs:180000});
const routes=new ChatRouteService(store,execution,new TaskService(store,execution),{profile:request=>routeRoleProfile(store,request)});let evidence:Record<string,unknown>={status:'blocked',kind:'real_locked_cli_structured_router',inferenceRequested:false};
try{
 const before=store.tasks(project.id);evidence.inferenceRequested=true;
 const route=routes.propose({projectId:project.id,messageId:'public-native-route',text:'只查询 PUBLIC_ROUTER_TASK 的当前状态，不要创建任务，不要修改、暂停、取消或续接。请提案恰好一个 QUERY_TASK 操作。',taskId:task.taskId,focusRevision:0});
 await execution.wait();await routes.tick(project.id);const proposed=store.mainRoutes(project.id).find(r=>r.id===route.id)!;
 if(proposed.state!=='proposed'||proposed.steps.length!==1||proposed.steps[0]?.operation.kind!=='QUERY_TASK'||proposed.steps[0].operation.taskId!==task.taskId)throw Error('NATIVE_ROUTE_PROPOSAL_MISMATCH');
 if(JSON.stringify(store.tasks(project.id))!==JSON.stringify(before))throw Error('PROPOSAL_MUTATED_TASKS');
 const result=await routes.commit({projectId:project.id,planId:proposed.id,expectedVersion:proposed.version});
 const run=store.runForHost(proposed.routingRunId!),usage=store.resourceBudget();
 if(result.state!=='completed'||result.steps[0]?.state!=='completed'||execution.diagnostics.clientTurnStarts!==1)throw Error('NATIVE_ROUTE_COMMIT_FAILED');
 evidence={status:'passed',kind:'real_locked_cli_structured_router',inferenceRequested:true,provider:'original_supported_codex_login',model:execution.diagnostics.selectedModel,threadAccepted:Boolean(run.threadId),turnAccepted:Boolean(run.turnId),runStatus:run.status,routeStatus:result.state,stepKinds:result.steps.map(s=>s.operation.kind),stepStates:result.steps.map(s=>s.state),clientThreadStarts:execution.diagnostics.clientThreadStarts,clientTurnStarts:execution.diagnostics.clientTurnStarts,nativePolicyVerified:execution.diagnostics.nativePolicyVerified,serverRequestsDenied:execution.diagnostics.serverRequestsDenied,reportedTokens:usage.reportedTokens,proposalTaskMutation:false,tools:'none',ephemeral:true};
}catch(error){evidence.code=error instanceof Error?error.message:'HOST_ERROR';evidence.diagnosticCode=execution.diagnostics.failureCode;evidence.clientTurnStarts=execution.diagnostics.clientTurnStarts;}finally{await execution.close();store.close();}
evidence.observedAt=new Date().toISOString();writeFileSync(join(root,'docs/progress/evidence/M3.1b-native-routing.json'),JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify(evidence,null,2));if(evidence.status!=='passed')process.exitCode=1;
