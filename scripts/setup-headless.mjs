import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const distribution = await readFile('/etc/os-release', 'utf8');
if (
  process.platform !== 'linux' ||
  process.arch !== 'x64' ||
  !/^ID=debian$/m.test(distribution) ||
  !/^VERSION_ID="13"$/m.test(distribution)
)
  throw new Error('HEADLESS_SETUP_REQUIRES_DEBIAN_13_X64');
const packages = JSON.parse(
  await readFile(resolve(root, 'scripts/headless-packages.json'), 'utf8'),
);
const cache = resolve(root, '.local/apt');
const sysroot = resolve(root, '.local/system');
for (const path of [cache, sysroot, `${cache}/lists/partial`, `${cache}/cache/archives/partial`])
  await mkdir(path, { recursive: true });
const sources = `${cache}/sources.list`;
await writeFile(
  sources,
  'deb https://deb.debian.org/debian trixie main\ndeb https://deb.debian.org/debian trixie-updates main\ndeb https://security.debian.org/debian-security trixie-security main\n',
);
const options = [
  '-o',
  `Dir::State::lists=${cache}/lists`,
  '-o',
  `Dir::Cache=${cache}/cache`,
  '-o',
  `Dir::Etc::sourcelist=${sources}`,
  '-o',
  'Dir::Etc::sourceparts=-',
];
function run(command, args) {
  const result = spawnSync(command, args, { cwd: cache, stdio: 'inherit', env: process.env });
  if (result.status !== 0) throw new Error(`HEADLESS_SETUP_COMMAND_FAILED_${command}`);
}
let indexReady = false;
for (const item of packages) {
  const file = resolve(cache, item.file);
  let bytes;
  try {
    bytes = await readFile(file);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (!bytes) {
    // Signed indexes and package hashes remain mandatory. Never change global APT sources or install as root.
    if (!indexReady) {
      run('apt-get', [...options, 'update']);
      indexReady = true;
    }
    run('apt-get', [...options, 'download', item.package]);
    bytes = await readFile(file);
  }
  if (createHash('sha256').update(bytes).digest('hex') !== item.sha256)
    throw new Error('HEADLESS_PACKAGE_HASH_MISMATCH');
  run('dpkg-deb', ['--extract', file, sysroot]);
}
await writeFile(resolve(sysroot, 'packages.json'), JSON.stringify(packages, null, 2) + '\n');
console.log(
  'Verified and extracted four pinned Debian packages into .local/system. No system configuration changed.',
);
