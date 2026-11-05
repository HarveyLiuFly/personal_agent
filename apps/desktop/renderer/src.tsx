import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { ConnectionInfo } from '../src/bridge.ts';
import { HistoryApp } from './history-app.tsx';
import { subscribeRefresh } from './host-events.ts';
import './style.css';
function App() {
  const [connection, setConnection] = useState<ConnectionInfo>(),
    [busy, setBusy] = useState(false);
  async function inspect() {
    if (busy) return;
    setBusy(true);
    try {
      setConnection(await window.personalAgent.inspect());
    } catch {
      setConnection({ status: 'error', errorCode: 'HOST_DISCONNECTED' });
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void inspect();
  }, []);
  const indexPending = connection?.errorCode === 'CODEX_STATE_INDEX_PENDING';
  // While the Host builds the Codex index, its progress and completion arrive as change notices.
  useEffect(() => (indexPending ? subscribeRefresh(inspect) : undefined), [indexPending]);
  const text = busy
    ? '正在连接 Codex…'
    : connection?.status === 'connected'
      ? 'Codex 已连接'
      : indexPending
        ? connection?.index
          ? connection.index.state === 'waiting'
            ? `Codex 索引准备中（等待上次未完成的索引释放，已处理 ${connection.index.threads} 个会话）`
            : `Codex 索引准备中（已处理 ${connection.index.threads} 个会话）`
          : 'Codex 索引准备中'
        : 'Codex 暂未连接';
  return (
    <HistoryApp>
      <div
        className="connection-chip"
        role="status"
        data-connected={connection?.status === 'connected'}
      >
        <span
          className={'status-dot ' + (connection?.status === 'connected' ? 'connected' : '')}
          aria-hidden="true"
        />
        <span
          title={
            connection?.status === 'connected' ? `模型目录可读 · ${connection.models} 个模型` : text
          }
        >
          {text}
        </span>
        <button
          data-action="inspect"
          aria-label="重新检查 Codex 连接"
          className="text-button"
          disabled={busy}
          onClick={() => void inspect()}
        >
          ↻
        </button>
      </div>
    </HistoryApp>
  );
}
const root = document.getElementById('root');
if (!root) throw Error('ROOT_MISSING');
createRoot(root).render(<App />);
