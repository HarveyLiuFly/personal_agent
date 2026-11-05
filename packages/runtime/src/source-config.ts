import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from 'node:fs';
import type { Stats } from 'node:fs';
import { dirname, isAbsolute, parse, resolve, sep } from 'node:path';
import type { TrustedSourceConfig } from '../../contracts/src/goals.ts';
import type { AuthenticatedSourceConnection } from './source-poller.ts';
export const SOURCE_CONFIG_MAX_BYTES = 2 * 1024 * 1024;
export interface HostSourceConfiguration {
  bindings: TrustedSourceConfig[];
  connections: AuthenticatedSourceConnection[];
}
export class SourceConfigError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}
const fail = (code: string): never => {
  throw new SourceConfigError(code);
};
const control = /[\x00-\x1f\x7f]/;
const id = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 200 && !control.test(value);
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const ids = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.length >= 1 &&
  value.length <= 20 &&
  value.every(id) &&
  new Set(value).size === value.length;
function safeFile(info: Stats): boolean {
  return (
    info.isFile() &&
    !info.isSymbolicLink() &&
    info.nlink === 1 &&
    (info.mode & 0o7777) === 0o600 &&
    (!process.getuid || info.uid === process.getuid()) &&
    Number.isSafeInteger(info.size) &&
    info.size > 0 &&
    info.size <= SOURCE_CONFIG_MAX_BYTES
  );
}
function parents(file: string): void {
  const directory = dirname(file),
    root = parse(directory).root;
  let current = root;
  for (const part of directory.slice(root.length).split(sep).filter(Boolean)) {
    current = resolve(current, part);
    const info = lstatSync(current);
    if (!info.isDirectory() || info.isSymbolicLink()) fail('SOURCE_CONFIG_UNSAFE');
  }
  if (realpathSync(directory) !== directory) fail('SOURCE_CONFIG_UNSAFE');
}
function decode(bytes: Buffer): HostSourceConfiguration {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return fail('SOURCE_CONFIG_INVALID');
  }
  if (
    !object(raw) ||
    !exact(raw, ['format', 'sources']) ||
    raw.format !== 1 ||
    !Array.isArray(raw.sources) ||
    raw.sources.length > 100
  )
    return fail('SOURCE_CONFIG_INVALID');
  const bindings: TrustedSourceConfig[] = [],
    connections: AuthenticatedSourceConnection[] = [],
    seen = new Set<string>();
  for (const source of raw.sources) {
    if (
      !object(source) ||
      !exact(source, ['binding', 'connection']) ||
      !object(source.binding) ||
      !object(source.connection)
    )
      return fail('SOURCE_CONFIG_INVALID');
    const b = source.binding,
      c = source.connection;
    if (
      !exact(b, [
        'sourceId',
        'bindingRef',
        'allowedActors',
        'selfActor',
        'eventTypes',
        'maxAgeMs',
      ]) ||
      !id(b.sourceId) ||
      !id(b.bindingRef) ||
      !id(b.selfActor) ||
      !ids(b.allowedActors) ||
      !ids(b.eventTypes) ||
      !Number.isSafeInteger(b.maxAgeMs) ||
      Number(b.maxAgeMs) < 1 ||
      Number(b.maxAgeMs) > 86400000 ||
      seen.has(b.sourceId) ||
      !exact(c, ['url', 'token']) ||
      typeof c.url !== 'string' ||
      c.url.length > 8192 ||
      control.test(c.url) ||
      typeof c.token !== 'string' ||
      !/^[\x21-\x7e]{16,4096}$/.test(c.token)
    )
      return fail('SOURCE_CONFIG_INVALID');
    let url: URL;
    try {
      url = new URL(c.url);
    } catch {
      return fail('SOURCE_CONFIG_INVALID');
    }
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.hash)
      return fail('SOURCE_CONFIG_INVALID');
    // Public bindings can enter catalog DTOs. Never allow a configured secret to be copied into them.
    if (JSON.stringify(b).includes(c.token)) return fail('SOURCE_CONFIG_INVALID');
    seen.add(b.sourceId);
    bindings.push({
      sourceId: b.sourceId,
      bindingRef: b.bindingRef,
      allowedActors: [...b.allowedActors],
      selfActor: b.selfActor,
      eventTypes: [...b.eventTypes],
      maxAgeMs: Number(b.maxAgeMs),
    });
    connections.push({
      sourceId: b.sourceId,
      bindingRef: b.bindingRef,
      url: c.url,
      token: c.token,
    });
  }
  for (const binding of bindings)
    for (const connection of connections)
      if (JSON.stringify(binding).includes(connection.token)) return fail('SOURCE_CONFIG_INVALID');
  return { bindings, connections };
}
/** The caller supplies its fixed Host-owned userData path. This function has no IPC or account discovery surface. */
export function loadSourceConfiguration(file: string): HostSourceConfiguration {
  if (
    typeof file !== 'string' ||
    !file ||
    file.length > 4096 ||
    !isAbsolute(file) ||
    resolve(file) !== file ||
    control.test(file)
  )
    return fail('SOURCE_CONFIG_UNSAFE');
  let fd: number | undefined;
  try {
    let before: Stats;
    try {
      before = lstatSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return { bindings: [], connections: [] };
      throw error;
    }
    if (!safeFile(before)) return fail('SOURCE_CONFIG_UNSAFE');
    parents(file);
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = fstatSync(fd);
    if (!safeFile(opened) || opened.dev !== before.dev || opened.ino !== before.ino)
      return fail('SOURCE_CONFIG_CHANGED');
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count === 0) return fail('SOURCE_CONFIG_CHANGED');
      offset += count;
    }
    const after = fstatSync(fd),
      named = lstatSync(file);
    parents(file);
    if (
      !safeFile(after) ||
      !safeFile(named) ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs ||
      named.dev !== opened.dev ||
      named.ino !== opened.ino ||
      realpathSync(file) !== file
    )
      return fail('SOURCE_CONFIG_CHANGED');
    return decode(bytes);
  } catch (error) {
    if (error instanceof SourceConfigError) throw error;
    return fail('SOURCE_CONFIG_UNSAFE');
  } finally {
    if (fd !== undefined)
      try {
        closeSync(fd);
      } catch {}
  }
}
