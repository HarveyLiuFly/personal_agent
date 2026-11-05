import { rm, copyFile } from 'node:fs/promises';
import { build as bundle } from 'esbuild';
import { build as buildRenderer } from 'vite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
await rm(resolve(root, 'build/desktop'), { recursive: true, force: true });
await bundle({
  entryPoints: [resolve(root, 'apps/desktop/src/main.ts')],
  outfile: resolve(root, 'build/desktop/main.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['electron'],
});
await copyFile(
  resolve(root, 'docs/design/contracts/schema.sql'),
  resolve(root, 'build/desktop/schema.sql'),
);
await copyFile(
  resolve(root, 'packages/verification/src/reporter.mjs'),
  resolve(root, 'build/desktop/verification-reporter.mjs'),
);
await copyFile(
  resolve(root, 'packages/workspace/src/reader.mjs'),
  resolve(root, 'build/desktop/workspace-reader.mjs'),
);
await copyFile(
  resolve(root, 'packages/workspace/src/terminal-worker.mjs'),
  resolve(root, 'build/desktop/terminal-worker.mjs'),
);
await copyFile(
  resolve(root, 'packages/workspace/src/worktree-worker.mjs'),
  resolve(root, 'build/desktop/worktree-worker.mjs'),
);
await bundle({
  entryPoints: [resolve(root, 'apps/desktop/src/preload.ts')],
  outfile: resolve(root, 'build/desktop/preload.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
});
await buildRenderer({
  configFile: false,
  root: resolve(root, 'apps/desktop/renderer'),
  base: './',
  build: { outDir: resolve(root, 'build/desktop/renderer'), emptyOutDir: true },
});
