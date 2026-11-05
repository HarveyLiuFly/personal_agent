import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';
import { projectSkillViews } from '../packages/codex-adapter/src/skills.ts';
import { RpcFailure } from '../packages/codex-adapter/src/rpc.ts';

const cwd = '/public/project';
const opaque = (identity: string) => createHash('sha256').update(identity).digest('hex');
const skill = (extra: Record<string, unknown> = {}) => ({
  name: 'public-skill',
  description: 'Public description',
  path: cwd + '/.agents/skills/public/SKILL.md',
  scope: 'repo',
  enabled: true,
  pluginId: null,
  ...extra,
});
const response = (skills: unknown[] = [], errors: unknown[] = [], root = cwd) => ({
  data: [{ cwd: root, skills, errors }],
});
const code = (expected: string) => (error: unknown) =>
  error instanceof RpcFailure &&
  error.code === expected &&
  error.message === expected &&
  error.details === undefined;

test('controlled stable response projects only bounded public metadata with interface and legacy precedence', async () => {
  const fixture = {
    request: async (method: string, params: unknown) => {
      assert.equal(method, 'skills/list');
      assert.deepEqual(params, { cwds: [cwd] });
      return response([
        skill({
          interface: {
            displayName: 'Public UI name',
            shortDescription: 'UI summary',
            defaultPrompt: 'DO_NOT_COPY_PROMPT',
          },
          shortDescription: 'Legacy summary',
          description: 'DO_NOT_COPY_LONG_DESCRIPTION',
        }),
        skill({
          name: 'legacy',
          path: cwd + '/legacy/SKILL.md',
          shortDescription: 'Legacy summary',
        }),
        skill({ name: 'fallback', path: cwd + '/fallback/SKILL.md' }),
        skill({ name: 'disabled-preview', path: cwd + '/disabled/SKILL.md', enabled: false }),
      ]);
    },
  };
  const projected = projectSkillViews(
    cwd,
    await fixture.request('skills/list', { cwds: [cwd] }),
    opaque,
  );
  assert.equal(projected.skills.length, 4);
  assert.equal(projected.skills[0]!.displayName, 'Public UI name');
  assert.equal(projected.skills[0]!.description, 'UI summary');
  assert.equal(projected.skills[1]!.description, 'Legacy summary');
  assert.equal(projected.skills[2]!.description, 'Public description');
  assert.equal(projected.invalidEntries, 0);
  assert.equal(projected.truncated, false);
  assert.equal(JSON.stringify(projected).includes('DO_NOT_COPY'), false);
});
test('global scopes and unknown scope never read private metadata or allocate identifiers', () => {
  let identifiers = 0;
  const hidden = (scope: unknown) => {
    const entry: Record<string, unknown> = { scope };
    for (const key of ['name', 'description', 'path', 'interface', 'dependencies'])
      Object.defineProperty(entry, key, {
        get() {
          throw Error('GLOBAL_PRIVATE_FIELD_ACCESSED');
        },
      });
    return entry;
  };
  const result = projectSkillViews(
    cwd,
    response([
      hidden('user'),
      hidden('system'),
      hidden('admin'),
      hidden('future'),
      hidden(undefined),
    ]),
    () => {
      identifiers++;
      return 'opaque';
    },
  );
  assert.deepEqual(result, { skills: [], scanErrors: 0, invalidEntries: 2, truncated: false });
  assert.equal(identifiers, 0);
});
test('CWD binding rejects foreign, normalized aliases, duplicate and mixed-project responses', () => {
  for (const result of [
    { data: [] },
    response([], [], cwd + '/'),
    response([], [], '/public/project/../project'),
    { data: [...response().data, ...response().data] },
    { data: [...response().data, ...response([], [], '/foreign').data] },
  ])
    assert.throws(
      () => projectSkillViews(cwd, result, opaque),
      code('SKILL_CATALOG_SCOPE_MISMATCH'),
    );
  for (const result of [
    null,
    [],
    {},
    { data: null },
    { data: {} },
    { data: [null] },
    { data: [{ cwd, skills: [] }] },
    { data: [{ cwd, skills: {}, errors: [] }] },
    { data: [{ cwd, skills: [], errors: {} }] },
    { data: [], extra: 'untrusted' },
  ])
    assert.throws(
      () => projectSkillViews(cwd, result, opaque),
      (error) =>
        error instanceof RpcFailure &&
        ['SKILL_CATALOG_SCOPE_MISMATCH', 'INVALID_SKILL_CATALOG'].includes(error.code),
    );
});
test('repo paths must be absolute and lexically contained; no ancestor or sibling metadata is exported', () => {
  const entries = [
    skill({ path: '/public/project-other/SKILL.md' }),
    skill({ path: '/public/SKILL.md' }),
    skill({ path: cwd + '/../other/SKILL.md' }),
    skill({ path: 'relative/SKILL.md' }),
    skill({ path: cwd + '/bad\n/SKILL.md' }),
    skill({ path: cwd + '/good/../valid/SKILL.md' }),
  ];
  const result = projectSkillViews(cwd, response(entries), opaque);
  assert.equal(result.invalidEntries, 5);
  assert.equal(result.skills.length, 1);
  assert.equal(JSON.stringify(result).includes('SKILL.md'), false);
});
test('same-name distinct paths and distinct projects retain separate opaque identities while exact duplicates dedupe', () => {
  let allocated = 0;
  const idFor = (identity: string) => {
    allocated++;
    return opaque(identity);
  };
  const a = skill({ path: cwd + '/a/SKILL.md' }),
    b = skill({ path: cwd + '/b/SKILL.md' }),
    result = projectSkillViews(
      cwd,
      response([a, { ...a }, { ...a, path: cwd + '/a/../a/SKILL.md' }, b]),
      idFor,
    );
  assert.equal(result.skills.length, 2);
  assert.equal(allocated, 2);
  assert.notEqual(result.skills[0]!.id, result.skills[1]!.id);
  const nested = cwd + '/nested',
    samePath = skill({ path: nested + '/a/SKILL.md' }),
    outer = projectSkillViews(cwd, response([samePath]), opaque),
    inner = projectSkillViews(nested, response([samePath], [], nested), opaque);
  assert.notEqual(outer.skills[0]!.id, inner.skills[0]!.id);
});
test('name/display/description clipping preserves Unicode pairs and marks each partial view', () => {
  const original = skill({
      name: 'n'.repeat(99) + '🙂',
      description: 'd'.repeat(999) + '🙂',
      interface: { displayName: 'v'.repeat(99) + '🙂' },
    }),
    result = projectSkillViews(cwd, response([original]), opaque),
    view = result.skills[0]!;
  assert.equal(view.name, 'n'.repeat(99));
  assert.equal(view.displayName, 'v'.repeat(99));
  assert.equal(view.description, 'd'.repeat(999));
  assert.equal(view.truncated, true);
  assert.equal(result.truncated, true);
  for (const text of [view.name, view.displayName, view.description])
    assert.equal(/[\uD800-\uDBFF]$/.test(text!), false);
});
test('200 unique entries cap output without allocating IDs for omitted or duplicate records', () => {
  const entries = Array.from({ length: 205 }, (_, i) =>
    skill({ name: 's' + i, path: cwd + '/' + i + '/SKILL.md', description: '' }),
  );
  let allocated = 0;
  const result = projectSkillViews(cwd, response([...entries, entries[0]]), (identity) => {
    allocated++;
    return opaque(identity);
  });
  assert.equal(result.skills.length, 200);
  assert.equal(allocated, 200);
  assert.equal(result.invalidEntries, 0);
  assert.equal(result.truncated, true);
  assert.equal(result.skills[0]!.truncated, false);
});
test('aggregate UTF16 text stays within 65536 and exhausted space never creates an unnamed record', () => {
  const entries = Array.from({ length: 150 }, (_, i) =>
    skill({
      name: 'skill-' + i,
      path: cwd + '/' + i + '/SKILL.md',
      description: '🙂'.repeat(500),
      interface: { displayName: '界'.repeat(100) },
    }),
  );
  const result = projectSkillViews(cwd, response(entries), opaque),
    total = result.skills.reduce(
      (n, s) => n + s.name.length + (s.displayName?.length ?? 0) + s.description.length,
      0,
    );
  assert.ok(total <= 65536);
  assert.equal(result.truncated, true);
  assert.ok(result.skills.length < 150);
  assert.ok(
    result.skills.every(
      (s) => s.name.length > 0 && s.name.length <= 100 && s.description.length <= 1000,
    ),
  );
  for (const s of result.skills) assert.equal(/[\uD800-\uDBFF]$/.test(s.description), false);
});
test('missing and malformed repo metadata is counted once per entry without filling defaults', () => {
  const entries = [
    null,
    [],
    {},
    skill({ name: '' }),
    skill({ name: 5 }),
    skill({ description: undefined }),
    skill({ description: {} }),
    skill({ path: null }),
    skill({ shortDescription: 3 }),
    skill({ interface: null }),
    skill({ interface: { displayName: 1 } }),
    skill({ interface: { shortDescription: {} } }),
    skill({ path: cwd + '/' + 'p'.repeat(8192) }),
    skill({ description: 'x'.repeat(65537) }),
    skill({ name: 'x'.repeat(4097) }),
  ];
  const result = projectSkillViews(cwd, response(entries), opaque);
  assert.equal(result.invalidEntries, entries.length);
  assert.deepEqual(result.skills, []);
  assert.equal(result.truncated, false);
});
test('scan errors are counts only and secrets, paths, icons, dependencies and body never enter DTOs', () => {
  const unused = () => {
      throw Error('UNUSED_PRIVATE_FIELD_ACCESSED');
    },
    ui: Record<string, unknown> = { displayName: 'Public', shortDescription: 'Public summary' },
    entry = skill({ interface: ui });
  for (const key of ['iconSmall', 'iconLarge', 'iconSmallUrl', 'iconLargeUrl', 'defaultPrompt'])
    Object.defineProperty(ui, key, { get: unused });
  for (const key of ['dependencies', 'pluginId', 'body', 'enabled'])
    Object.defineProperty(entry, key, { get: unused });
  const error: Record<string, unknown> = {};
  for (const key of ['path', 'message']) Object.defineProperty(error, key, { get: unused });
  const result = projectSkillViews(cwd, response([entry], [error, error]), opaque);
  assert.equal(result.scanErrors, 2);
  assert.equal(result.invalidEntries, 0);
  assert.deepEqual(
    Object.keys(result.skills[0]!).sort(),
    ['id', 'name', 'displayName', 'description', 'truncated'].sort(),
  );
  assert.equal(JSON.stringify(result).includes(cwd), false);
  assert.equal(JSON.stringify(result).includes('SKILL.md'), false);
});
test('HTML remains an inert text value and lexical validation performs no filesystem access', () => {
  const methods = [
      'openSync',
      'readFileSync',
      'readdirSync',
      'statSync',
      'lstatSync',
      'realpathSync',
      'accessSync',
      'existsSync',
    ] as const,
    originals = new Map<string, unknown>();
  let result;
  try {
    for (const method of methods) {
      originals.set(method, fs[method]);
      (fs as unknown as Record<string, unknown>)[method] = () => {
        throw Error('FILESYSTEM_ACCESSED');
      };
    }
    syncBuiltinESMExports();
    result = projectSkillViews(
      cwd,
      response([
        skill({
          description: '<img src=x onerror=alert(1)>',
          interface: { displayName: '<script>fixture</script>' },
        }),
      ]),
      opaque,
    );
  } finally {
    for (const method of methods)
      (fs as unknown as Record<string, unknown>)[method] = originals.get(method);
    syncBuiltinESMExports();
  }
  assert.equal(result.skills[0]!.description, '<img src=x onerror=alert(1)>');
  assert.equal(result.skills[0]!.displayName, '<script>fixture</script>');
});
test('oversized transport collections and failed Host identity mapping yield fixed errors without private diagnostics', () => {
  assert.throws(
    () => projectSkillViews(cwd, response(new Array(10001).fill(skill())), opaque),
    code('INVALID_SKILL_CATALOG'),
  );
  assert.throws(
    () =>
      projectSkillViews(cwd, response([skill()]), () => {
        throw Error('/private/secret/path');
      }),
    code('INVALID_SKILL_CATALOG'),
  );
  for (const value of ['', 'x'.repeat(201), 'bad\nidentity'])
    assert.throws(
      () => projectSkillViews(cwd, response([skill()]), () => value),
      code('INVALID_SKILL_CATALOG'),
    );
});
