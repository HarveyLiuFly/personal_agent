import {readFileSync,writeSync} from 'node:fs';
import {ExecutionLedger} from '../../packages/store/src/ledger.ts';
import {BackupService} from '../../packages/backup/src/service.ts';
const [file,directory,receipts,backupId,stage]=process.argv.slice(2) as [string,string,string,string,string];const store=new ExecutionLedger(file,readFileSync('docs/design/contracts/schema.sql','utf8'));store.startOwner('rehearsal-crash-owner',true);const service=new BackupService(store,{directory,verificationDirectory:receipts,afterRehearsalStage:at=>{if(at===stage){writeSync(1,JSON.stringify({stage:at})+'\n');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);}}});service.command({kind:'rehearse',backupId,commandKey:'crash-rehearsal'});
