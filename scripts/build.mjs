import { rm } from 'node:fs/promises';
import { build as bundle } from 'esbuild';
import { build as buildRenderer } from 'vite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
await rm(resolve(root, 'build/desktop'), { recursive: true, force: true });
await bundle({ entryPoints: [resolve(root, 'apps/desktop/src/main.ts')], outfile: resolve(root, 'build/desktop/main.js'),
  bundle: true, platform: 'node', format: 'esm', target: 'node22', external: ['electron'] });
await bundle({ entryPoints: [resolve(root, 'apps/desktop/src/preload.ts')], outfile: resolve(root, 'build/desktop/preload.cjs'),
  bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['electron'] });
await buildRenderer({ configFile: false, root: resolve(root, 'apps/desktop/renderer'), base: './',
  build: { outDir: resolve(root, 'build/desktop/renderer'), emptyOutDir: true } });
