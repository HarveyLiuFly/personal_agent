import { realpathSync, statSync, mkdirSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

export function resolveExecutable(name: string): string {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (!directory) continue;
    const file = join(directory, name);
    try { if (statSync(file).isFile()) return realpathSync(file); } catch {}
  }
  throw new Error('CODEX_EXECUTABLE_MISSING');
}
export function resolveVerifierNode(root: string): string {
  const local = resolve(root, `.local/node-v24.19.0-${process.platform}-${process.arch}/bin/node`);
  const file = existsSync(local) ? realpathSync(local) : resolveExecutable('node');
  const version = execFileSync(file, ['--version'], { encoding: 'utf8', timeout: 5000, maxBuffer: 4096,
    env: { PATH: process.env.PATH, HOME: process.env.HOME }, stdio: ['ignore','pipe','ignore'] }).trim();
  const match = /^v24\.(\d+)\.\d+$/.exec(version);
  if (!match || Number(match[1]) < 19) throw new Error('VERIFIER_NODE_VERSION_UNSUPPORTED');
  return file;
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
    '-c', 'history.persistence="none"', '-c', 'analytics.enabled=false',
    '-c', 'features.unbounded_connection_retries=false', 'app-server', '--stdio'];
}
