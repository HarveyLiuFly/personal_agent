import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { ConnectionInfo, SmokeInfo } from '../src/bridge.ts';
import './style.css';

function App() {
  const [connection, setConnection] = useState<ConnectionInfo>();
  const [result, setResult] = useState<SmokeInfo>();
  const [busy, setBusy] = useState(false);
  async function act(task: 'inspect' | 'smoke') {
    if (busy) return;
    setBusy(true);
    try {
      if (task === 'inspect') setConnection(await window.personalAgent.inspect());
      else setResult(await window.personalAgent.runSmoke());
    } finally { setBusy(false); }
  }
  return <main>
    <header><span className="eyebrow">PERSONAL WORKSPACE</span><h1>Personal Agent</h1>
      <p>连接你的 Codex，逐步构建持续工作的个人助手。</p></header>
    <section className="card"><h2>桌面开发预览</h2><p>先确认运行环境，再完成一次只读连接验证。</p>
      <div className="actions"><button disabled={busy} onClick={() => void act('inspect')}>检查连接</button>
        <button className="secondary" disabled={busy} onClick={() => void act('smoke')}>运行验证</button></div>
      <p role="status">{busy ? '正在连接…' : connection?.status === 'connected'
        ? `已连接 · ${connection.defaultModel} · ${connection.models} 个可用模型`
        : connection?.errorCode ? `连接未完成：${connection.errorCode}` : '尚未检查连接'}</p>
      {result && <pre>{result.status === 'passed' ? `验证完成\n${result.finalText}` : `验证未完成：${result.errorCode}`}</pre>}
    </section>
    <footer>本地工作区 · Codex 执行引擎</footer>
  </main>;
}
const root = document.getElementById('root');
if (!root) throw new Error('ROOT_MISSING');
createRoot(root).render(<App />);
