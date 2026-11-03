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
    <p role="status" data-connected={connection?.status === 'connected'}>{busy ? '正在启动 Codex 并读取模型目录，首次索引可能需要等待…' : connection?.status === 'connected'
      ? `目录已连接 · ${connection.models} 个模型` : connection?.errorCode === 'CODEX_STATE_INDEX_PENDING'
        ? '本机 Codex 历史索引尚未就绪，请稍后再次检查连接。无需重新登录，尚未发送模型任务。'
        : connection?.errorCode ? `连接未完成：${connection.errorCode}` : '尚未检查连接'}</p>
  </div></HistoryApp>;
}
const root = document.getElementById('root');
if (!root) throw new Error('ROOT_MISSING');
createRoot(root).render(<App />);
