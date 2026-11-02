import { spawnSync } from 'node:child_process';
for (const target of ['protocol:verify', 'typecheck', 'test', 'test:contracts', 'build']) {
  const result = spawnSync('pnpm', [target], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
