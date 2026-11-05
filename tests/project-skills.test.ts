import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProjectSkillCatalog } from '../packages/runtime/src/skills.ts';
import type { ReadPort } from '../packages/codex-adapter/src/history.ts';
const directory = '/public/project',
  skill = {
    name: 'public-skill',
    description: 'Public description',
    path: directory + '/.agents/skills/public/SKILL.md',
    scope: 'repo',
    enabled: true,
  };
function fixture() {
  let reads = 0,
    lookups = 0,
    changed = false;
  const calls: Array<{ method: string; params: unknown }> = [];
  const raw = { data: [{ cwd: directory, skills: [skill], errors: [] }] };
  const service = new ProjectSkillCatalog({
    workspace: (id) => {
      lookups++;
      return { id, name: 'public', directory: changed ? '/public/other' : directory };
    },
    read: async <T>(read: (p: ReadPort) => Promise<T>) => {
      reads++;
      return read({
        request: async <R>(method: string, params: unknown) => {
          calls.push({ method, params });
          return raw as R;
        },
      });
    },
  });
  return {
    service,
    calls,
    raw,
    reads: () => reads,
    lookups: () => lookups,
    change: () => {
      changed = true;
    },
  };
}
test('project catalog issues only a scoped skills query and exposes advisory metadata without paths or activation', async () => {
  const f = fixture(),
    view = await f.service.list({ projectId: 'project' });
  assert.equal(f.reads(), 1);
  assert.equal(f.lookups(), 2);
  assert.deepEqual(f.calls, [
    { method: 'skills/list', params: { cwds: [directory], forceReload: true } },
  ]);
  assert.equal(view.skills[0]?.name, 'public-skill');
  assert.equal(view.source, 'locked_cli_isolated_project_discovery');
  assert.equal(view.executionCapabilities.mcp, 'not_enabled');
  assert.equal(JSON.stringify(view).includes(directory), false);
  assert.equal(Object.hasOwn(view.skills[0]!, 'path'), false);
});
test('catalog rejects raw paths, extra keys and invalid project identity before opening a connection', async () => {
  const f = fixture();
  for (const input of [
    { projectId: 'p', cwd: directory },
    { projectId: 'p', forceReload: true },
    { projectId: '' },
    { projectId: 'p\n' },
    null,
  ])
    await assert.rejects(() => f.service.list(input), /INVALID_SKILL_QUERY/);
  assert.equal(f.reads(), 0);
  const wrong = new ProjectSkillCatalog({
    workspace: () => ({ id: 'foreign', directory, name: 'public' }),
    read: async <T>() => {
      throw Error('must not connect');
    },
  });
  await assert.rejects(() => wrong.list({ projectId: 'p' }), /SKILL_PROJECT_SCOPE_MISMATCH/);
});
test('workspace is revalidated after the metadata read, and opaque IDs are stable only within the same catalog owner', async () => {
  let count = 0;
  const changing = new ProjectSkillCatalog({
    workspace: (id) => ({
      id,
      name: 'public',
      directory: ++count === 1 ? directory : '/public/replaced',
    }),
    read: async <T>(read: (p: ReadPort) => Promise<T>) =>
      read({
        request: async <R>() => ({ data: [{ cwd: directory, skills: [skill], errors: [] }] }) as R,
      }),
  });
  await assert.rejects(() => changing.list({ projectId: 'p' }), /PROJECT_IDENTITY_CHANGED/);
  const a = fixture(),
    b = fixture();
  const first = await a.service.list({ projectId: 'p' }),
    second = await a.service.list({ projectId: 'p' }),
    other = await b.service.list({ projectId: 'p' });
  assert.equal(first.skills[0]?.id, second.skills[0]?.id);
  assert.notEqual(first.skills[0]?.id, other.skills[0]?.id);
});
