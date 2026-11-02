import React, { useState } from 'react';
import type { InteractionView } from '../../../packages/contracts/src/views.ts';
export function InteractionCard({ request, reply }: { request: InteractionView; reply(decision: 'accept'|'decline', answers?: Record<string,string>): Promise<void> }) {
  const [answers,setAnswers] = useState<Record<string,string>>({}), [pending,setPending] = useState(false), [error,setError] = useState(false);
  async function act(decision:'accept'|'decline') { if(pending)return;setPending(true);setError(false);try{await reply(decision,request.kind==='input'?answers:undefined);}catch{setError(true);}finally{setPending(false);} }
  return <article className="item approval" data-interaction-id={request.requestId}>
    <div className="item-meta"><strong>{request.title}</strong><span>等待你的决定</span></div><pre>{request.detail}</pre>
    {request.questions.map(q=><label className="input-question" key={q.id}>{q.header} · {q.question}
      {q.options.length>0 && <select value={answers[q.id]??''} onChange={e=>setAnswers(old=>({...old,[q.id]:e.target.value}))}><option value="">选择建议答案</option>{q.options.map(o=><option key={o} value={o}>{o}</option>)}</select>}
      <input data-question-id={q.id} maxLength={2000} value={answers[q.id]??''} onChange={e=>setAnswers(old=>({...old,[q.id]:e.target.value}))}/>
    </label>)}
    <div className="approval-actions"><button data-action="decline-request" disabled={pending} onClick={()=>void act('decline')}>{request.kind==='input'?'取消补充':'拒绝'}</button>
      <button data-action="accept-request" disabled={pending || !request.canAccept || request.questions.some(q=>!answers[q.id]?.trim())} onClick={()=>void act('accept')}>{request.kind==='input'?'提交回答':'仅允许本次'}</button></div>
    {error && <p role="alert">该请求可能已结束或连接已变化，请查看最新状态。</p>}
  </article>;
}
