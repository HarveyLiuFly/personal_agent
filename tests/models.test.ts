import assert from 'node:assert/strict';
import { test } from 'node:test';
import { modelCatalog } from '../packages/codex-adapter/src/models.ts';

const port = (data: unknown) => ({ request: async <T>() => ({ data }) as T });

test('the model catalog keeps visible models with their efforts and needs a default', async () => {
  const models = await modelCatalog(
    port([
      {
        id: 'gpt-main',
        displayName: 'Main',
        description: 'Default model',
        isDefault: true,
        hidden: false,
        supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }],
        defaultReasoningEffort: 'low',
      },
      { id: 'gpt-hidden', hidden: true, isDefault: false, supportedReasoningEfforts: [] },
    ]),
  );
  assert.deepEqual(models, [
    {
      id: 'gpt-main',
      displayName: 'Main',
      description: 'Default model',
      isDefault: true,
      efforts: ['low', 'high'],
      defaultEffort: 'low',
    },
  ]);
  await assert.rejects(
    modelCatalog(port([{ id: 'x', isDefault: false, supportedReasoningEfforts: [] }])),
    /NO_DEFAULT_MODEL/,
  );
  await assert.rejects(
    modelCatalog(port([{ id: 'bad id', supportedReasoningEfforts: [] }])),
    /INVALID_MODEL_CATALOG/,
  );
  await assert.rejects(modelCatalog(port('nope')), /INVALID_MODEL_CATALOG/);
});
