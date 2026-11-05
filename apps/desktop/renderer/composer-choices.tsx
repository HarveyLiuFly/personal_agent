import React, { useEffect, useState } from 'react';
import type { HostResult } from '../../../packages/contracts/src/views.ts';
import type {
  ConversationChoices,
  ModelOption,
  PermissionMode,
} from '../../../packages/contracts/src/conversations.ts';

let catalog: Promise<ModelOption[]> | undefined;
/** The model catalog, read once per window (a failed read is retried next time). */
function models(): Promise<ModelOption[]> {
  catalog ??= window.personalAgent
    .listModels()
    .then((result: HostResult<ModelOption[]>) => {
      if (!result.ok) throw Error(result.errorCode);
      return result.value;
    })
    .catch((error: unknown) => {
      catalog = undefined;
      throw error;
    });
  return catalog;
}
export const permissionLabels: Record<PermissionMode, string> = {
  readOnly: '只读',
  auto: '自动',
  fullAccess: '完全访问',
};
const effortLabels: Record<string, string> = {
  none: '不推理',
  minimal: '最少',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '最高',
};

/**
 * Model, reasoning effort and permission mode for the next turn. Full access needs a second,
 * explicit confirmation on the page. `lockedPermission` fixes the mode (a fork is read-only, a
 * code task is auto).
 */
export function ComposerChoices({
  value,
  onChange,
  disabled = false,
  lockedPermission,
}: {
  value: Required<ConversationChoices>;
  onChange: (change: ConversationChoices) => void;
  disabled?: boolean;
  lockedPermission?: PermissionMode;
}) {
  const [options, setOptions] = useState<ModelOption[]>([]),
    [confirming, setConfirming] = useState(false);
  useEffect(() => {
    let stopped = false;
    models()
      .then((list) => {
        if (!stopped) setOptions(list);
      })
      .catch(() => undefined);
    return () => {
      stopped = true;
    };
  }, []);
  const fallback = options.find((model) => model.isDefault),
    selected = options.find((model) => model.id === value.model) ?? fallback,
    permission = lockedPermission ?? value.permissionMode;
  return (
    <div className="composer-choices" data-composer-choices>
      <select
        aria-label="模型"
        data-choice="model"
        disabled={disabled}
        value={value.model ?? ''}
        onChange={(e) => onChange({ model: e.target.value || null, effort: null })}
      >
        <option value="">{fallback ? `默认（${fallback.displayName}）` : '默认模型'}</option>
        {options
          .filter((model) => !model.isDefault)
          .map((model) => (
            <option key={model.id} value={model.id} title={model.description}>
              {model.displayName}
            </option>
          ))}
        {value.model && !options.some((model) => model.id === value.model) && (
          <option value={value.model}>{value.model}（不可用，将用默认）</option>
        )}
      </select>
      <select
        aria-label="推理强度"
        data-choice="effort"
        disabled={disabled}
        value={value.effort ?? ''}
        onChange={(e) => onChange({ effort: e.target.value || null })}
      >
        <option value="">推理：默认</option>
        {(selected?.efforts ?? []).map((effort) => (
          <option key={effort} value={effort}>
            推理：{effortLabels[effort] ?? effort}
          </option>
        ))}
      </select>
      <select
        aria-label="权限"
        data-choice="permission"
        disabled={disabled || Boolean(lockedPermission)}
        value={permission}
        onChange={(e) => {
          const next = e.target.value as PermissionMode;
          if (next === 'fullAccess') setConfirming(true);
          else {
            setConfirming(false);
            onChange({ permissionMode: next });
          }
        }}
      >
        <option value="readOnly">只读</option>
        <option value="auto" title="可以修改工作区内的文件，需要越出沙箱时先询问">
          自动
        </option>
        <option value="fullAccess">完全访问</option>
      </select>
      {confirming && (
        <div
          className="notice error full-access-confirm"
          role="alertdialog"
          aria-label="确认完全访问"
        >
          完全访问让 Agent
          在本机不经沙箱、也不再询问就能运行命令和修改任何文件。只在你信任这次任务时使用。
          <button
            data-action="confirm-full-access"
            onClick={() => {
              setConfirming(false);
              onChange({ permissionMode: 'fullAccess' });
            }}
          >
            确认使用完全访问
          </button>
          <button className="secondary" onClick={() => setConfirming(false)}>
            取消
          </button>
        </div>
      )}
    </div>
  );
}
