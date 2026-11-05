import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { ProjectSkillView } from '../../contracts/src/skills.ts';
import { isObject, RpcFailure } from './rpc.ts';

const control = /[\x00-\x1f\x7f]/;
const text = (value: unknown, maximum: number): value is string =>
  typeof value === 'string' && value.length <= maximum && !value.includes('\0');
const name = (value: unknown): value is string =>
  text(value, 4096) && value.trim().length > 0 && !control.test(value);
const pathText = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 8192 && !control.test(value);
const exact = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
function invalid(): never {
  throw new RpcFailure('INVALID_SKILL_CATALOG');
}
function cut(value: string, maximum: number): string {
  const prefix = value.slice(0, Math.max(0, maximum));
  return /[\uD800-\uDBFF]$/.test(prefix) ? prefix.slice(0, -1) : prefix;
}

/** Stable skills/list metadata only. Paths are lexical identity input; this function never reads skill files. */
export function projectSkillViews(
  expectedCwd: string,
  response: unknown,
  idFor: (identity: string) => string,
): { skills: ProjectSkillView[]; scanErrors: number; invalidEntries: number; truncated: boolean } {
  if (
    !pathText(expectedCwd) ||
    !isAbsolute(expectedCwd) ||
    !isObject(response) ||
    !exact(response, ['data']) ||
    !Array.isArray(response.data)
  )
    invalid();
  if (response.data.length !== 1) throw new RpcFailure('SKILL_CATALOG_SCOPE_MISMATCH');
  const entry: unknown = response.data[0];
  if (
    !isObject(entry) ||
    !exact(entry, ['cwd', 'skills', 'errors']) ||
    typeof entry.cwd !== 'string'
  )
    invalid();
  if (entry.cwd !== expectedCwd) throw new RpcFailure('SKILL_CATALOG_SCOPE_MISMATCH');
  if (!Array.isArray(entry.skills) || entry.skills.length > 10000 || !Array.isArray(entry.errors))
    invalid();
  const skills: ProjectSkillView[] = [],
    seen = new Set<string>();
  let invalidEntries = 0,
    truncated = false,
    total = 0;
  for (const candidate of entry.skills) {
    if (!isObject(candidate)) {
      invalidEntries++;
      continue;
    }
    // Scope is inspected before ANY other skill metadata. Global skills may contain private fields.
    const scope = candidate.scope;
    if (scope === 'user' || scope === 'system' || scope === 'admin') continue;
    if (scope !== 'repo') {
      invalidEntries++;
      continue;
    }
    if (
      !name(candidate.name) ||
      !text(candidate.description, 65536) ||
      !pathText(candidate.path) ||
      !isAbsolute(candidate.path)
    ) {
      invalidEntries++;
      continue;
    }
    const skillName = candidate.name,
      skillPath = resolve(candidate.path),
      local = relative(expectedCwd, skillPath);
    if (isAbsolute(local) || local === '..' || local.startsWith('..' + sep)) {
      invalidEntries++;
      continue;
    }
    const legacy = candidate.shortDescription,
      ui = candidate.interface;
    if ((legacy !== undefined && !text(legacy, 65536)) || (ui !== undefined && !isObject(ui))) {
      invalidEntries++;
      continue;
    }
    const display = ui?.displayName,
      short = ui?.shortDescription;
    if (
      (display !== undefined && (!text(display, 4096) || control.test(display))) ||
      (short !== undefined && !text(short, 65536))
    ) {
      invalidEntries++;
      continue;
    }
    const identity = JSON.stringify([expectedCwd, scope, skillPath, skillName]);
    if (seen.has(identity)) continue;
    seen.add(identity);
    if (skills.length >= 200 || total >= 65536) {
      truncated = true;
      continue;
    }
    const rawDisplay = typeof display === 'string' && display.trim() ? display : null;
    const rawDescription =
      typeof short === 'string' && short
        ? short
        : typeof legacy === 'string' && legacy
          ? legacy
          : candidate.description;
    const shownName = cut(skillName, Math.min(100, 65536 - total));
    if (!shownName) {
      truncated = true;
      continue;
    }
    total += shownName.length;
    const shownDisplay = rawDisplay === null ? null : cut(rawDisplay, Math.min(100, 65536 - total));
    total += shownDisplay?.length ?? 0;
    const description = cut(rawDescription, Math.min(1000, 65536 - total));
    total += description.length;
    const clipped =
      shownName !== skillName || shownDisplay !== rawDisplay || description !== rawDescription;
    let id: string;
    try {
      id = idFor(identity);
    } catch {
      invalid();
    }
    if (typeof id !== 'string' || id.length < 1 || id.length > 200 || control.test(id)) invalid();
    skills.push({
      id,
      name: shownName,
      displayName: shownDisplay || null,
      description,
      truncated: clipped,
    });
    truncated ||= clipped;
  }
  return { skills, scanErrors: entry.errors.length, invalidEntries, truncated };
}
