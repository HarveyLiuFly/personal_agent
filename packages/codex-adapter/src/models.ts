import type { ModelOption } from '../../contracts/src/conversations.ts';
import type { ReadPort } from './history.ts';
import { isObject, RpcFailure } from './rpc.ts';

const text = (value: unknown, limit: number) =>
  typeof value === 'string' ? value.slice(0, limit) : '';
/** The visible models of the pinned Codex catalog with their reasoning efforts (read-only). */
export async function modelCatalog(port: ReadPort): Promise<ModelOption[]> {
  const response = await port.request<unknown>('model/list', {});
  if (!isObject(response) || !Array.isArray(response.data) || response.data.length > 100)
    throw new RpcFailure('INVALID_MODEL_CATALOG');
  const options: ModelOption[] = [];
  for (const model of response.data) {
    if (
      !isObject(model) ||
      typeof model.id !== 'string' ||
      !/^[\w.:/-]{1,200}$/.test(model.id) ||
      !Array.isArray(model.supportedReasoningEfforts)
    )
      throw new RpcFailure('INVALID_MODEL_CATALOG');
    if (model.hidden === true) continue;
    options.push({
      id: model.id,
      displayName: text(model.displayName, 120) || model.id,
      description: text(model.description, 400),
      isDefault: model.isDefault === true,
      efforts: model.supportedReasoningEfforts
        .map((option) => (isObject(option) ? text(option.reasoningEffort, 32) : ''))
        .filter(Boolean),
      defaultEffort: text(model.defaultReasoningEffort, 32) || null,
    });
  }
  if (!options.some((model) => model.isDefault)) throw new RpcFailure('NO_DEFAULT_MODEL');
  return options;
}
