import React, { useEffect, useState } from 'react';
import type { HostResult, ProjectView } from '../../../packages/contracts/src/views.ts';
import type {
  ProjectCheckSetting,
  ProjectCheckView,
} from '../../../packages/contracts/src/conversations.ts';

async function value<T>(request: Promise<HostResult<T>>): Promise<T> {
  const result = await request;
  if (!result.ok) throw Error(result.errorCode);
  return result.value;
}
export const checkLabels: Record<ProjectCheckView['status'], string> = {
  passed: '检查通过',
  failed: '检查未通过',
  timeout: '检查超时',
  error: '检查无法运行',
};
/** One check run, shown as a step after the turn it followed. */
export function CheckStep({ check }: { check: ProjectCheckView }) {
  return (
    <div className={'check-step ' + check.status} data-check-status={check.status}>
      <span className={'badge ' + (check.status === 'passed' ? 'completed' : 'failed')}>
        {checkLabels[check.status]}
      </span>
      <code>{check.label}</code>
      <small className="muted">
        {(check.durationMs / 1000).toFixed(1)} 秒{check.automatic ? ' · 自动' : ''}
        {check.exitCode !== null && check.status !== 'passed' ? ` · 退出码 ${check.exitCode}` : ''}
      </small>
      {check.output && (
        <details>
          <summary>输出{check.outputTruncated ? '（末尾部分）' : ''}</summary>
          <pre>{check.output}</pre>
        </details>
      )}
    </div>
  );
}
/**
 * The project's check command: run it for this conversation, or set it from a preset or a typed
 * command line (no shell), optionally after every turn that could write files.
 */
export function CheckControls({
  project,
  conversationId,
  disabled,
  onError,
}: {
  project: ProjectView;
  conversationId: string;
  disabled: boolean;
  onError: (message: string) => void;
}) {
  const [setting, setSetting] = useState<ProjectCheckSetting>(),
    [editing, setEditing] = useState(false),
    [running, setRunning] = useState(false),
    [preset, setPreset] = useState('custom'),
    [command, setCommand] = useState(''),
    [autoRun, setAutoRun] = useState(false);
  useEffect(() => {
    let stopped = false;
    void value(window.personalAgent.getProjectCheck({ projectId: project.id }))
      .then((next) => {
        if (stopped) return;
        setSetting(next);
        setAutoRun(next.config?.autoRun ?? false);
        const match = next.presets.find(
          (option) => JSON.stringify(option.argv) === JSON.stringify(next.config?.argv),
        );
        setPreset(match?.id ?? (next.config ? 'custom' : 'pytest'));
        if (next.config && !match) setCommand(next.config.argv.join(' '));
      })
      .catch(() => undefined);
    return () => {
      stopped = true;
    };
  }, [project.id]);
  async function save(remove = false) {
    try {
      const next = await value(
        window.personalAgent.setProjectCheck(
          remove
            ? { projectId: project.id, remove: true }
            : preset === 'custom'
              ? { projectId: project.id, command, autoRun }
              : { projectId: project.id, preset, autoRun },
        ),
      );
      setSetting(next);
      setEditing(false);
    } catch (cause) {
      onError(
        cause instanceof Error && /NEEDS_NO_SHELL/.test(cause.message)
          ? '检查命令不经过 shell：去掉 |、&&、;、> 或 $，或写成一个脚本再运行。'
          : '检查命令无效，请检查写法。',
      );
    }
  }
  async function run() {
    setRunning(true);
    try {
      await value(window.personalAgent.runProjectCheck({ projectId: project.id, conversationId }));
    } catch (cause) {
      onError(
        cause instanceof Error && /CHECK_RUNNING/.test(cause.message)
          ? '这个项目的检查正在运行。'
          : '检查没有运行，请稍后再试。',
      );
    } finally {
      setRunning(false);
    }
  }
  if (!setting) return null;
  return (
    <span className="check-controls">
      {setting.config && (
        <button
          className="text-button"
          data-action="run-check"
          disabled={disabled || running}
          title={setting.config.label}
          onClick={() => void run()}
        >
          {running ? '正在检查…' : '运行检查'}
        </button>
      )}
      <button
        className="text-button"
        data-action="edit-check"
        onClick={() => setEditing((open) => !open)}
      >
        {setting.config ? '检查设置' : '设置检查命令'}
      </button>
      {editing && (
        <div className="check-form" data-check-form>
          <label>
            检查命令
            <select value={preset} onChange={(e) => setPreset(e.target.value)}>
              {setting.presets.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
              <option value="custom">自定义…</option>
            </select>
          </label>
          {preset === 'custom' && (
            <input
              aria-label="自定义检查命令"
              data-check-command
              placeholder="例如 python3 -m pytest -q"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
            />
          )}
          <label className="inline-check">
            <input
              type="checkbox"
              checked={autoRun}
              onChange={(e) => setAutoRun(e.target.checked)}
            />
            每轮修改文件后自动运行
          </label>
          <p className="muted">在 Codex 沙箱里运行：可写工作区，不能联网，不经过 shell。</p>
          <button data-action="save-check" onClick={() => void save()}>
            保存
          </button>
          {setting.config && (
            <button className="secondary" onClick={() => void save(true)}>
              不再使用
            </button>
          )}
        </div>
      )}
    </span>
  );
}
