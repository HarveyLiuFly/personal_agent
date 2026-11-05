import { readFileSync } from 'node:fs';
import { ExecutionLedger, LedgerError } from '../../packages/store/src/ledger.ts';
import { BackupService } from '../../packages/backup/src/service.ts';
const [file, directory, receipts, id, kind] = process.argv.slice(2) as [
  string,
  string,
  string,
  string,
  string,
];
const store = new ExecutionLedger(file, readFileSync('docs/design/contracts/schema.sql', 'utf8'));
try {
  if (kind === 'source') store.startOwner('fifo-fixture', true);
  const service = new BackupService(store, { directory, verificationDirectory: receipts });
  try {
    service.command(
      kind === 'source'
        ? { kind: 'create', commandKey: 'source-fifo' }
        : { kind: 'verify', backupId: id },
    );
    process.exitCode = 1;
  } catch (error) {
    if (error instanceof LedgerError && error.code === 'BACKUP_FILE_INVALID')
      process.stdout.write('FIFO_REJECTED\n');
    else process.exitCode = 2;
  }
} finally {
  store.close();
}
