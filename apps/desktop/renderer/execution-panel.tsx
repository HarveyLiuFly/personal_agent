import React, { useEffect, useRef, useState } from 'react';
import type { HostResult, InteractionView, ProjectView, RunSummary, RunView, VerificationView } from '../../../packages/contracts/src/views.ts';
import { InteractionCard } from './interactions.tsx';
async function value<T>(request: Promise<HostResult<T>>): Promise<T> { const r = await request; if (!r.ok) throw new Error(r.errorCode); return r.value; }
const labels: Record<string,string> = { preparing: '正在连接', submitting: '正在发送', running: '执行中', completed: '执行已结束 · 待验证', failed: '执行失败', cancelled: '已中断', outcome_unknown: '结果未知 · 待核对', waiting_approval: '等待批准', waiting_input: '等待补充' };
export function ExecutionPanel({ project, disabled = false, mode = 'readOnly', canCode = false }: { project: ProjectView; disabled?: boolean; mode?: 'readOnly'|'workspaceWrite'; canCode?: boolean }) {
  const [runs,setRuns] = useState<RunSummary[]>([]), [selected,setSelected] = useState<string>(), [view,setView] = useState<RunView>();
  const [codeEnabled,setCodeEnabled] = useState(false), [target,setTarget] = useState(''), [paths,setPaths] = useState('');
  const [review,setReview] = useState<VerificationView>(), [verifying,setVerifying] = useState(false);
  const [requests,setRequests] = useState<InteractionView[]>([]), [stopping,setStopping] = useState(false);
  const [draft,setDraft] = useState(''), [sending,setSending] = useState(false), [error,setError] = useState<string>();
  const key = useRef<string | undefined>(undefined), pendingDraft = useRef<string | undefined>(undefined);
  const selectedRef = useRef(selected); selectedRef.current = selected;
  useEffect(() => {
    let stopped = false, timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const rows = await value(window.personalAgent.listRuns({ projectId: project.id })); if (stopped) return;
        setRuns(rows); const runId = selectedRef.current ?? rows[0]?.runId;
        if (runId) {
          const next = await value(window.personalAgent.getRun({ projectId: project.id, runId })); if (stopped || (selectedRef.current && selectedRef.current !== runId)) return;
          setSelected(runId); selectedRef.current = runId; setView(next);
          const pending = await value(window.personalAgent.listInteractions({ projectId: project.id, runId })); if (stopped || selectedRef.current !== runId) return; setRequests(pending.filter(request => request.state === 'pending'));
          if (next.turnId && pendingDraft.current === runId) { setDraft(''); key.current = undefined; pendingDraft.current = undefined; }
        }
      } catch { if (!stopped) setError('无法更新执行状态。草稿已保留，请检查连接；不要重复提交结果未知的请求。'); }
      finally { if (!stopped) timer = setTimeout(() => void poll(), 300); }
    };
    void poll(); return () => { stopped = true; clearTimeout(timer); };
  }, [project.id]);
  const blocked = runs.some(run => ['preparing','submitting','running','waiting_input','waiting_approval','outcome_unknown'].includes(run.status));
  async function send() {
    if (disabled || sending || blocked || !draft.trim() || (codeEnabled && (!target.trim() || !paths.trim()))) return;
    setSending(true); setError(undefined); key.current ??= crypto.randomUUID();
    try {
      const run = await value(window.personalAgent.submitMessage({ projectId: project.id, text: draft, submissionKey: key.current, ...(codeEnabled ? {code:{profile:'node-test' as const,target:target.trim(),allowedPaths:paths.split(/[\n,]/).map(p=>p.trim()).filter(Boolean)}} : {}) }));
      setReview(undefined); setStopping(false); setSelected(run.runId); selectedRef.current = run.runId; setRequests([]); pendingDraft.current = run.runId;
      setRuns(rows => [run,...rows.filter(row => row.runId !== run.runId)]);
    } catch (failure) { setError(failure instanceof Error && failure.message === 'RUNTIME_BUSY' ? '已有执行尚未结束或待核对，请先处理当前任务。' : '提交未确认，草稿和提交标识已保留。请先检查执行记录。'); }
    finally { setSending(false); }
  }
  async function verify() {
    if (!view || verifying) return;
    const runId=view.runId;setVerifying(true);
    try {
      const next=await value(window.personalAgent.verifyRun({projectId:project.id,runId}));
      const current=await value(window.personalAgent.getRun({projectId:project.id,runId}));
      if(selectedRef.current===runId){setReview(next);setView(current);}
    }catch{setError('验证尚未完成，任务仍需审查。');}
    finally{setVerifying(false);}
  }
  return <>
    <section className="history-panel" data-execution-panel>
      <div className="history-heading"><h2>项目任务</h2><span className="badge">{(view?.mode ?? (codeEnabled ? 'workspaceWrite' : mode)) === 'readOnly' ? '只读执行' : '工作区写入'}</span></div>
      <div className="turn-list">{runs.map(run => <button className={`turn ${run.runId === selected ? 'selected' : ''}`} data-run-id={run.runId} key={run.runId} onClick={() => { setReview(undefined); setStopping(false); setSelected(run.runId); selectedRef.current = run.runId; setView(undefined); setRequests([]); }}>{run.title.slice(0,28)}</button>)}</div>
      {error && <div role="alert" className="notice error">{error}</div>}
      {view ? <>
        {['preparing','submitting','running','waiting_input','waiting_approval'].includes(view.status) && <button className="secondary" data-action="interrupt-run" disabled={stopping} onClick={() => { setStopping(true); void value(window.personalAgent.interruptRun({projectId:project.id,runId:view.runId})).catch(()=>setError('停止尚未确认，请查看待核对状态。')); }}>停止</button>}
        <p className="history-note" role="status" data-run-status={view.status} data-task-status={view.taskStatus}>{view.taskStatus === 'completed' ? '已验证完成' : labels[view.status] ?? '状态未知'}</p>
        {view.errorCode && ['failed','outcome_unknown'].includes(view.status) && <div className="notice error">执行未完成：{view.errorCode}。请保留记录，结果未知时不要重复提交。</div>}
        {view.mode === 'workspaceWrite' && canCode && ['completed','failed','cancelled','outcome_unknown'].includes(view.status) && <div className="approval-actions">
          <button data-action="review-run" disabled={verifying} onClick={()=>{void value(window.personalAgent.getVerification({projectId:project.id,runId:view.runId})).then(setReview).catch(()=>setError('无法读取验证合同或 Diff。'));}}>查看 Diff 与验证合同</button>
          <button data-action="verify-run" disabled={verifying || view.status !== 'completed' || view.taskStatus !== 'needs_review'} onClick={()=>void verify()}>{verifying?'正在验证…':'运行固定验证'}</button>
        </div>}
        {review && <article className="item" data-verification-status={review.receipt?.status ?? 'pending'}><strong>验证合同 · {review.target ?? '未配置'}</strong><p className="history-note">允许修改：{review.allowedPaths.join('、')} · 必要测试 {review.requiredCases} 项</p>
          {review.receipt && <p role="status">{review.receipt.status === 'passed' ? '验证通过' : '尚未通过'} · 发现 {review.receipt.discovered} / 实际执行 {review.receipt.executed} / 跳过 {review.receipt.skipped} · {review.receipt.code}</p>}
          <pre data-run-diff>{review.diff || '当前没有可显示的 Diff。'}</pre>{review.diffTruncated&&<small>Diff 过长，仅显示部分。</small>}
        </article>}
        {view.blocked && <div className="notice">该请求需要核对，新的执行已暂停。系统不会自动重发。</div>}
        {view.snapshot?.needsSnapshot && <div className="notice">连接已断开，以下为最后保存的内容，尚未核对最新结果。</div>}
        {requests.map(request=><InteractionCard key={request.requestId} request={request} reply={async(decision,answers)=>{await value(window.personalAgent.replyInteraction({projectId:project.id,runId:view.runId,requestId:request.requestId,decision,...(answers?{answers}:{})}));setRequests(rows=>rows.filter(r=>r.requestId!==request.requestId));}}/>)}
        <div className="items" data-execution-items>{view.snapshot?.items.map(item => <article key={`${item.turnId}:${item.id}`} className={`item ${item.role}`} data-execution-item={item.id} data-item-status={item.status}>
          <div className="item-meta"><strong>{item.label}</strong><span>{item.status === 'streaming' ? '正在接收' : item.status === 'complete' ? '记录已结束' : '状态未知'}</span></div><pre>{item.text}</pre>
          {item.truncated && <small className="clip-note">仅显示部分内容</small>}
        </article>)}</div>
      </> : <div className="empty-history">可以提出项目问题。当前只读模式，执行结束后仍需独立验证。</div>}
    </section>
    {canCode && <div className="code-contract"><label><input type="checkbox" data-code-profile checked={codeEnabled} disabled={blocked || sending} onChange={e=>{setCodeEnabled(e.target.checked);key.current=undefined;}}/> 新消息作为代码任务：只修改指定文件，使用固定 Node 测试验证</label>
      {codeEnabled && <div className="code-options"><label>测试入口<input data-code-target value={target} disabled={blocked || sending} placeholder="test/math.test.mjs" onChange={e=>{setTarget(e.target.value);key.current=undefined;}}/></label><label>允许修改的文件（逗号分隔）<input data-code-paths value={paths} disabled={blocked || sending} placeholder="src/math.mjs" onChange={e=>{setPaths(e.target.value);key.current=undefined;}}/></label></div>}
    </div>}
    <footer className="composer"><textarea aria-label="任务输入" data-task-draft value={draft} maxLength={32768} disabled={disabled || sending || blocked} onChange={e => { setDraft(e.target.value); key.current = undefined; }} placeholder={codeEnabled?'描述需要完成的代码修改…':'提出一个只读问题…'} rows={2}/><button data-action="send" disabled={disabled || sending || blocked || !draft.trim() || (codeEnabled && (!target.trim() || !paths.trim()))} onClick={() => void send()}>发送 ↑</button></footer>
  </>;
}
