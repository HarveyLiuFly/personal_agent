import React from 'react';
import type {ResourceBudget} from '../../../packages/contracts/src/budget.ts';
/** Occupancy reflects the ledger. A lease or Unknown entry is never proof of process termination. */
export function ResourceView({budget,stale=false}:{budget:ResourceBudget;stale?:boolean}){
  const occupancy=budget.occupancy,sample=budget.mainProcess;
  return <section data-runtime-resources data-resources-stale={stale} className="runtime-resources"><strong>运行占用 · 本机共享</strong>
    {stale&&<p className="notice">资源更新失败，以下是上次保留的记录。</p>}
    {occupancy?<><div className="resource-grid"><span data-resource-models={occupancy.modelActive}>模型占用 {occupancy.modelActive} · 待核对 {occupancy.modelUnknown}</span><span data-resource-terminals={occupancy.terminalActive}>用户终端 {occupancy.terminalActive} · 待核对 {occupancy.terminalUnknown}</span><span>工作树操作 {occupancy.worktreeActive} · 待核对 {occupancy.worktreeUnknown}</span><span>写入租约 {occupancy.writeLeases} · 排队记录 {occupancy.queuedTasks}</span></div><small>占用与租约来自账本；待核对资源继续保留，排队记录不代表立即可派发。</small></>:<p className="history-note">占用信息暂不可用。</p>}
    {sample?<p className="history-note" data-main-resources>主进程 RSS {(sample.rssBytes/1024/1024).toFixed(1)} MiB · CPU {sample.cpuPercent===null?'采集中':sample.cpuPercent.toFixed(1)+'%'}（单核 = 100%）<br/><small>采样仅包含 Main 进程，不包含工具和其他进程。</small></p>:<p className="history-note">主进程采样暂不可用。</p>}
  </section>;
}
