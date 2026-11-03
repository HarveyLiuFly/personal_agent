import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {ExecutionLedger} from '../../packages/store/src/ledger.ts';
import {BackupService} from '../../packages/backup/src/service.ts';
import {RestoreService} from '../../packages/backup/src/restore.ts';
const [root,backupId,stage]=process.argv.slice(2) as [string,string,string],store=new ExecutionLedger(join(root,'execution/ledger.db'),readFileSync('docs/design/contracts/schema.sql','utf8'));store.startOwner('restore-fault-worker',true);
const backups=new BackupService(store,{directory:join(root,'backups'),verificationDirectory:join(root,'verification/artifacts')}),service=new RestoreService(store,backups,root,point=>{if(point===stage){process.stdout.write(JSON.stringify({stage:point})+'\n');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);}}),r=service.prepare({kind:'prepareRestore',backupId,commandKey:'crash-restore'});service.checkActivation({kind:'activateRestore',restoreId:r.id});store.close();service.activateAfterOwnerStopped(r.id);
