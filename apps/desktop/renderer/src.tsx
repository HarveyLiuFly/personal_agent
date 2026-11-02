import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { ConnectionInfo, SmokeInfo } from '../src/bridge.ts';
import './style.css';
import { HistoryApp } from './history-app.tsx';

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
    } catch {
      if (task === 'inspect') setConnection({ status: 'error', errorCode: 'HOST_DISCONNECTED' });
      else setResult({ status: 'error', errorCode: 'HOST_DISCONNECTED' });
    } finally { setBusy(false); }
  }
  return <HistoryApp><div className="runtime-panel">
    <div className="connection-actions"><button data-action="inspect" className="secondary" disabled={busy} onClick={() => void act('inspect')}>检查连接</button>
      <button className="text-button" disabled={busy} onClick={() => void act('smoke')}>验证模型</button></div>
    <p role="status" data-connected={connection?.status === 'connected'}>{busy ? '正在连接…' : connection?.status === 'connected'
      ? `目录已连接 · ${connection.models} 个模型` : connection?.errorCode ? `连接未完成：${connection.errorCode}` : '尚未检查连接'}</p>
    {result && <p className="runtime-result">{result.status === 'passed' ? `模型验证完成：${result.finalText}` : `模型验证未完成：${result.errorCode}`}</p>}
  </div></HistoryApp>;
}
const root = document.getElementById('root');
if (!root) throw new Error('ROOT_MISSING');
createRoot(root).render(<App />);
