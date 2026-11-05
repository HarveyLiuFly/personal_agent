import { spawn } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  realpathSync,
  lstatSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import electron from 'electron';
import { createCodeFixture } from '../tests/fixtures/code-project.ts';

// Human walkthrough only: real production Main, separate data, no smoke flags or model sends.
const flags = process.argv.slice(2);
if (flags.length > 1 || flags.some((flag) => !['--prepare', '--preflight'].includes(flag))) {
  throw Error('Usage: node scripts/manual-walkthrough.mjs [--prepare|--preflight]');
}
const root = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const session = resolve(root, '.local/m3-manual-20261103');
mkdirSync(session, { recursive: true, mode: 0o700 });
if (realpathSync(session) !== session) throw Error('WALKTHROUGH_SYMLINK_REFUSED');
const manifestPath = join(session, 'session.json');
let manifest;
try {
  if (!lstatSync(manifestPath).isFile() || lstatSync(manifestPath).isSymbolicLink())
    throw Error('WALKTHROUGH_MANIFEST_INVALID');
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  const projects = realpathSync(mkdtempSync(join(tmpdir(), 'personal-agent-manual-')));
  manifest = {
    format: 1,
    userData: join(session, 'profile'),
    projects,
    code: join(projects, 'walkthrough-code'),
    goal: join(projects, 'walkthrough-goal'),
    other: join(projects, 'walkthrough-other'),
  };
  // Persist first: a partial preparation fails closed on the next start, never resets a used fixture.
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
  for (const key of ['code', 'goal', 'other']) createCodeFixture(manifest[key]);
}
if (
  manifest.format !== 1 ||
  manifest.userData !== join(session, 'profile') ||
  dirname(manifest.projects) !== realpathSync(tmpdir()) ||
  !manifest.projects.split('/').at(-1).startsWith('personal-agent-manual-')
) {
  throw Error('WALKTHROUGH_MANIFEST_SCOPE');
}
for (const key of ['code', 'goal', 'other']) {
  if (
    manifest[key] !== join(manifest.projects, 'walkthrough-' + key) ||
    realpathSync(manifest[key]) !== manifest[key]
  ) {
    throw Error('WALKTHROUGH_PROJECT_SCOPE');
  }
}
mkdirSync(manifest.userData, { recursive: true, mode: 0o700 });
if (realpathSync(manifest.userData) !== manifest.userData) throw Error('WALKTHROUGH_PROFILE_SCOPE');
// Production boot can dispatch saved plans. A preflight must never reopen a used task profile.
if (flags.includes('--preflight')) {
  if (
    existsSync(join(manifest.userData, 'source-connections.json')) ||
    existsSync(join(manifest.userData, 'runtimes/active.json')) ||
    existsSync(join(manifest.userData, 'runtimes/ACTIVATION_REQUIRED'))
  )
    throw Error('WALKTHROUGH_PREFLIGHT_REQUIRES_EMPTY_PROFILE');
  const database = join(manifest.userData, 'execution/ledger.db');
  if (existsSync(database)) {
    const db = new DatabaseSync(database, { readOnly: true });
    try {
      for (const table of ['projects', 'tasks', 'task_runs', 'execution_intents']) {
        if (db.prepare('SELECT count(*) AS n FROM ' + table).get().n !== 0)
          throw Error('WALKTHROUGH_PREFLIGHT_REQUIRES_EMPTY_PROFILE');
      }
    } finally {
      db.close();
    }
  }
}
console.log('M3 人工走查：复用独立档案，不重置已有走查数据。');
console.log(JSON.stringify(manifest, null, 2));
if (!flags.includes('--prepare')) {
  await import('./build.mjs');
  const preflight = flags.includes('--preflight');
  const entry = join(session, preflight ? 'preflight.mjs' : 'launch.mjs');
  const receipt = join(session, 'boot-receipt.json');
  if (preflight) rmSync(receipt, { force: true });
  writeFileSync(
    entry,
    `import { app } from 'electron';
import { writeFileSync } from 'node:fs';
app.setPath('userData', ${JSON.stringify(manifest.userData)});
app.setName('Personal Agent M3 人工走查');
if (${preflight}) {
  const timer = setTimeout(() => { console.error('WALKTHROUGH_BOOT_TIMEOUT'); app.exit(1); }, 30000);
  app.once('browser-window-created', (_event, window) => {
    window.webContents.once('did-finish-load', () => {
      const prefs = window.webContents.getLastWebPreferences();
      const result = { format: 1, userData: app.getPath('userData'), productionEntry: true,
        sandbox: prefs.sandbox, contextIsolation: prefs.contextIsolation,
        nodeIntegration: prefs.nodeIntegration, webSecurity: prefs.webSecurity,
        humanCasesExecuted: 0, modelSubmissions: 0 };
      const ok = result.userData === ${JSON.stringify(manifest.userData)} && result.sandbox === true &&
        result.contextIsolation === true && result.nodeIntegration === false && result.webSecurity === true;
      writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({ ...result, ok }, null, 2) + '\\n', { mode: 0o600 });
      clearTimeout(timer); setTimeout(() => { if (ok) app.quit(); else app.exit(1); }, 250);
    });
  });
}
await import(${JSON.stringify(pathToFileURL(resolve(root, 'build/desktop/main.js')).href)});
`,
    { mode: 0o600 },
  );
  const child = spawn(electron, [entry], { cwd: root, stdio: 'inherit', env: process.env });
  child.once('error', (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  child.once('exit', (code) => {
    process.exitCode = code ?? 1;
    if (preflight && code === 0) {
      try {
        if (JSON.parse(readFileSync(receipt, 'utf8')).ok !== true) process.exitCode = 1;
      } catch {
        console.error('WALKTHROUGH_BOOT_RECEIPT_MISSING');
        process.exitCode = 1;
      }
    }
  });
}
