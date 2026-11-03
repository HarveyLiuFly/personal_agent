import React,{useRef,useState} from 'react';
import type {BackupCommand,BackupPage,BackupVerification} from '../../../packages/contracts/src/backups.ts';
import type {HostResult} from '../../../packages/contracts/src/views.ts';
async function value<T>(p:Promise<HostResult<T>>){const r=await p;if(!r.ok)throw Error(r.errorCode);return r.value;}
export function BackupManager(){
  const [page,setPage]=useState<BackupPage>(),[busy,setBusy]=useState(false),[error,setError]=useState<string>(),[createUnconfirmed,setCreateUnconfirmed]=useState(false),[checks,setChecks]=useState<Record<string,BackupVerification|'failed'>>({});const pending=useRef(false),key=useRef<string|undefined>(undefined);
  const rehearsalKeys=useRef<Record<string,string>>({}),[unconfirmedRehearsals,setUnconfirmedRehearsals]=useState<Record<string,boolean>>({});
  async function refresh(){if(pending.current)return;pending.current=true;setBusy(true);setError(undefined);try{setPage(await value(window.personalAgent.listBackups()));}catch{setError('暂时无法读取本机备份。');}finally{pending.current=false;setBusy(false);}}
  async function command(input:BackupCommand){
    if(pending.current)return;pending.current=true;setBusy(true);setError(undefined);
    try{const result=await value(window.personalAgent.applyBackupCommand(input));setChecks(rows=>({...rows,[result.backup.id]:result.verification}));if(input.kind==='create'){key.current=undefined;setCreateUnconfirmed(false);}if(input.kind==='rehearse'){delete rehearsalKeys.current[input.backupId];setUnconfirmedRehearsals(rows=>({...rows,[input.backupId]:false}));}}
    catch(e){if(input.kind==='verify')setChecks(rows=>({...rows,[input.backupId]:'failed'}));if(input.kind==='create')setCreateUnconfirmed(true);if(input.kind==='rehearse')setUnconfirmedRehearsals(rows=>({...rows,[input.backupId]:true}));setError(e instanceof Error&&(e.message==='BACKUP_COUNT_LIMIT'||e.message==='REHEARSAL_COUNT_LIMIT')?'已达到 20 份保存上限。':input.kind==='verify'?'完整性校验未通过，备份文件保持原样。':input.kind==='rehearse'?'恢复演练未确认完成，当前运行账本保持原样；可核对本次演练或显式另建副本。':'备份未确认完成，准备目录已保留；可核对本次备份或显式创建另一份。');}
    finally{try{setPage(await value(window.personalAgent.listBackups()));}catch{}pending.current=false;setBusy(false);}
  }
  return <details className="backup-manager" data-backup-manager onToggle={e=>{if(e.currentTarget.open&&!page)void refresh();}}><summary>本机备份</summary>
    <p className="history-note">保存执行账本和已发布的验证收据，包含任务内容。项目源码、Codex 历史文件、认证与终端输出不在此备份中。</p>
    <p className="history-note">本机私有保存，备份和恢复演练各最多 20 份。演练会生成隔离副本并整理旧状态，切换运行环境尚未开放。</p>
    <div className="queue-actions"><button data-action="create-backup" disabled={busy} onClick={()=>{key.current??=crypto.randomUUID();void command({kind:'create',commandKey:key.current});}}>{createUnconfirmed?'核对本次备份':'创建备份'}</button>{createUnconfirmed&&<button data-action="new-backup" disabled={busy} onClick={()=>{key.current=crypto.randomUUID();void command({kind:'create',commandKey:key.current});}}>创建另一份备份</button>}<button className="secondary" data-action="refresh-backups" disabled={busy} onClick={()=>void refresh()}>刷新列表</button></div>
    {error&&<p className="notice error" role="alert">{error}</p>}
    {page?.items.length===0&&<p data-backups-empty className="history-note">尚无本机备份。</p>}
    {page?.items.map(backup=>{const check=checks[backup.id];return <article key={backup.id} data-backup-id={backup.id} data-backup-state={backup.state}>
      <div><strong>{backup.createdAt?new Date(backup.createdAt).toLocaleString():'未完成的备份'}</strong><span className="badge">{backup.state==='available'?'已保存':backup.state==='incomplete'?'不完整 · 未发布':'清单或目录待核对'}</span></div>
      {backup.bytes!==null&&<p className="history-note">{(backup.bytes/1024/1024).toFixed(2)} MiB · {backup.receipts} 份验证收据</p>}
      <button className="secondary" data-action="verify-backup" disabled={busy||backup.state!=='available'} onClick={()=>void command({kind:'verify',backupId:backup.id})}>校验完整性</button>
      <button className="secondary" data-action="rehearse-backup" disabled={busy||backup.state!=='available'} onClick={()=>{rehearsalKeys.current[backup.id]??=crypto.randomUUID();void command({kind:'rehearse',backupId:backup.id,commandKey:rehearsalKeys.current[backup.id]!});}}>{unconfirmedRehearsals[backup.id]?'核对本次演练':'生成恢复演练'}</button>
      {unconfirmedRehearsals[backup.id]&&<button className="secondary" data-action="new-rehearsal" disabled={busy} onClick={()=>{rehearsalKeys.current[backup.id]=crypto.randomUUID();void command({kind:'rehearse',backupId:backup.id,commandKey:rehearsalKeys.current[backup.id]!});}}>另建演练副本</button>}
      {check==='failed'?<p className="notice error" data-backup-verified="failed">本次校验未通过。</p>:check&&<p className="history-note" data-backup-verified="passed">完整性通过 · {check.files} 个文件 · {new Date(check.verifiedAt).toLocaleString()}。快照中有 {check.activeRuns} 个未决模型执行、{check.pendingTerminals} 个未决终端、{check.pendingWorktreeOperations} 个未决工作树操作；校验不会启动它们。</p>}
    </article>;})}
    {Boolean(page?.rehearsals?.length)&&<section data-backup-rehearsals><h4>隔离恢复演练</h4><p className="history-note">以下为上次演练报告，副本未切换为当前运行环境。未决执行和租约保留待核对，演练不会启动旧任务或修改源码。</p>{page!.rehearsals!.map(r=><article key={r.id} data-rehearsal-id={r.id} data-rehearsal-state={r.state}><strong>{r.createdAt?new Date(r.createdAt).toLocaleString():'未完成的演练'}</strong><span className="badge">{r.state==='saved'?'已保存 · 隔离副本':r.state==='incomplete'?'准备未完成':'目录待核对'}</span>{r.summary&&<p className="history-note" data-rehearsal-summary>已合并 {r.summary.tombstones} 条删除记录 · 未决执行 {r.summary.unknownRuns} · 已暂停计划 {r.summary.pausedSchedules} · 旧授权失效 {r.summary.revokedApprovals} · 未决租约保留 {r.summary.retainedLeases}。运行入口已阻断。</p>}</article>)}</section>}
  </details>;
}
