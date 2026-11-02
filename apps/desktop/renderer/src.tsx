import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { ConnectionInfo } from '../src/bridge.ts';
import './style.css';
import { HistoryApp } from './history-app.tsx';

function App() {
  const [connection, setConnection] = useState<ConnectionInfo>();
  const [busy, setBusy] = useState(false);
  async function act() {
    if (busy) return;
    setBusy(true);
    try {
      setConnection(await window.personalAgent.inspect());
    } catch {
      setConnection({ status: 'error', errorCode: 'HOST_DISCONNECTED' });
    } finally { setBusy(false); }
  }
  return <HistoryApp><div className="runtime-panel">
    <div className="connection-actions"><button data-action="inspect" className="secondary" disabled={busy} onClick={() => void act()}>检查连接</button></div>
    <p role="status" data-connected={connection?.status === 'connected'}>{busy ? '正在连接…' : connection?.status === 'connected'
      ? `目录已连接 · ${connection.models} 个模型` : connection?.errorCode ? `连接未完成：${connection.errorCode}` : '尚未检查连接'}</p>
  </div></HistoryApp>;
}
const root = document.getElementById('root');
if (!root) throw new Error('ROOT_MISSING');
createRoot(root).render(<App />);
