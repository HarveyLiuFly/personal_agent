import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync, mkdirSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';

export function resolveExecutable(name: string): string {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (!directory) continue;
    const file = join(directory, name);
    try { if (statSync(file).isFile()) return realpathSync(file); } catch {}
  }
  throw new Error('CODEX_EXECUTABLE_MISSING');
}

export function verifyExecutable(executable: string, expectedSha256: string): void {
  if (createHash('sha256').update(readFileSync(executable)).digest('hex') !== expectedSha256) {
    throw new Error('CODEX_BINARY_MISMATCH');
  }
}

/** Preserve injected authentication/proxy guards for the trusted Runtime; no values are logged. */
export function runtimeEnvironment(): NodeJS.ProcessEnv {
  const exact = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'TERM', 'TMPDIR',
    'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
    'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE', 'NODE_EXTRA_CA_CERTS', 'OIC_MANIFEST_PATH']);
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (exact.has(name) || /^(CODEX_|OPENAI_|OAI_|OIC_|IDENTITY_|AZURE_|MSI_|AWS_|GOOGLE_|GCLOUD_|CLOUDSDK_|XDG_|LC_)/.test(name)) environment[name] = value;
  }
  return environment;
}

export function launchArguments(stateDirectory: string): string[] {
  const root = resolve(stateDirectory);
  mkdirSync(join(root, 'db'), { recursive: true, mode: 0o700 });
  mkdirSync(join(root, 'logs'), { recursive: true, mode: 0o700 });
  return ['-c', `sqlite_home=${JSON.stringify(join(root, 'db'))}`,
    '-c', `log_dir=${JSON.stringify(join(root, 'logs'))}`,
    '-c', 'history.persistence="none"', '-c', 'analytics.enabled=false', 'app-server', '--stdio'];
}
