import React,{useRef,useState} from 'react';
import type {BackupCommand,BackupPage,BackupVerification} from '../../../packages/contracts/src/backups.ts';
import type {HostResult} from '../../../packages/contracts/src/views.ts';
async function value<T>(p:Promise<HostResult<T>>){const r=await p;if(!r.ok)throw Error(r.errorCode);return r.value;}
export function BackupManager(){
  const [page,setPage]=useState<BackupPage>(),[busy,setBusy]=useState(false),[error,setError]=useState<string>(),[createUnconfirmed,setCreateUnconfirmed]=useState(false),[checks,setChecks]=useState<Record<string,BackupVerification|'failed'>>({});const pending=useRef(false),key=useRef<string|undefined>(undefined);
  async function refresh(){if(pending.current)return;pending.current=true;setBusy(true);setError(undefined);try{setPage(await value(window.personalAgent.listBackups()));}catch{setError('暂时无法读取本机备份。');}finally{pending.current=false;setBusy(false);}}
  async function command(input:BackupCommand){
    if(pending.current)return;pending.current=true;setBusy(true);setError(undefined);
    try{const result=await value(window.personalAgent.applyBackupCommand(input));setChecks(rows=>({...rows,[result.backup.id]:result.verification}));if(input.kind==='create'){key.current=undefined;setCreateUnconfirmed(false);}}
    catch(e){if(input.kind==='verify')setChecks(rows=>({...rows,[input.backupId]:'failed'}));else setCreateUnconfirmed(true);setError(e instanceof Error&&e.message==='BACKUP_COUNT_LIMIT'?'已达到 20 份本机备份上限。':input.kind==='verify'?'完整性校验未通过，备份文件保持原样。':'备份未确认完成，准备目录已保留；可核对本次备份或显式创建另一份。');}
    finally{try{setPage(await value(window.personalAgent.listBackups()));}catch{}pending.current=false;setBusy(false);}
  }
  return <details className="backup-manager" data-backup-manager onToggle={e=>{if(e.currentTarget.open&&!page)void refresh();}}><summary>本机备份</summary>
    <p className="history-note">保存执行账本和已发布的验证收据，包含任务内容。项目源码、Codex 历史文件、认证与终端输出不在此备份中。</p>
    <p className="history-note">本机私有保存，最多 20 份。当前提供保存与完整性校验，恢复运行环境尚未开放。</p>
    <div className="queue-actions"><button data-action="create-backup" disabled={busy} onClick={()=>{key.current??=crypto.randomUUID();void command({kind:'create',commandKey:key.current});}}>{createUnconfirmed?'核对本次备份':'创建备份'}</button>{createUnconfirmed&&<button data-action="new-backup" disabled={busy} onClick={()=>{key.current=crypto.randomUUID();void command({kind:'create',commandKey:key.current});}}>创建另一份备份</button>}<button className="secondary" data-action="refresh-backups" disabled={busy} onClick={()=>void refresh()}>刷新列表</button></div>
    {error&&<p className="notice error" role="alert">{error}</p>}
    {page?.items.length===0&&<p data-backups-empty className="history-note">尚无本机备份。</p>}
    {page?.items.map(backup=>{const check=checks[backup.id];return <article key={backup.id} data-backup-id={backup.id} data-backup-state={backup.state}>
      <div><strong>{backup.createdAt?new Date(backup.createdAt).toLocaleString():'未完成的备份'}</strong><span className="badge">{backup.state==='available'?'已保存':backup.state==='incomplete'?'不完整 · 未发布':'清单或目录待核对'}</span></div>
      {backup.bytes!==null&&<p className="history-note">{(backup.bytes/1024/1024).toFixed(2)} MiB · {backup.receipts} 份验证收据</p>}
      <button className="secondary" data-action="verify-backup" disabled={busy||backup.state!=='available'} onClick={()=>void command({kind:'verify',backupId:backup.id})}>校验完整性</button>
      {check==='failed'?<p className="notice error" data-backup-verified="failed">本次校验未通过。</p>:check&&<p className="history-note" data-backup-verified="passed">完整性通过 · {check.files} 个文件 · {new Date(check.verifiedAt).toLocaleString()}。快照中有 {check.activeRuns} 个未决模型执行、{check.pendingTerminals} 个未决终端、{check.pendingWorktreeOperations} 个未决工作树操作；校验不会启动它们。</p>}
    </article>;})}
  </details>;
}
