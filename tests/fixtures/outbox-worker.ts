import {readFileSync} from 'node:fs';
import {ExecutionLedger} from '../../packages/store/src/ledger.ts';
const [file,cwd,phase]=process.argv.slice(2);if(!file||!cwd||!phase)throw new Error('ARGUMENTS_REQUIRED');
let receipt:{projectId:string;taskId:string};
const ready=()=>{process.stdout.write(JSON.stringify(receipt)+'\n');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,15000);throw new Error('CHILD_WAS_NOT_KILLED');};
const store=new ExecutionLedger(file,readFileSync('docs/design/contracts/schema.sql','utf8'),{...(phase==='projection_transaction'?{afterOutboxProjectionForTests:ready}:{})});store.startOwner('real-outbox-child',true);const project=store.registerWorkspace(cwd,cwd),task=store.taskCommand({projectId:project.id,commandKey:'crash-create',kind:'create',text:'controlled outbox crash fixture'});receipt={projectId:project.id,taskId:task.taskId};const claim=store.claimOutbox(1)[0]!;
if(phase==='claimed')ready();else store.deliverOutbox(claim);
