import { build } from 'esbuild';
import { cpSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

/** 构建一个入口（CJS；Electron 主进程/沙箱 preload 均用 CJS 最稳）。 */
async function bundle(entry, outfile) {
  await build({
    absWorkingDir: root,
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    sourcemap: true,
    external: ['electron', 'electron-updater'],
    logLevel: 'info',
  });
}

mkdirSync(join(root, 'dist'), { recursive: true });
await bundle('src/main/main.ts', 'dist/main.cjs');
await bundle('src/preload/preload.ts', 'dist/preload.cjs');
cpSync(join(root, 'static'), join(root, 'dist'), { recursive: true });
console.log('[desktop] built dist/main.cjs + dist/preload.cjs + static assets');
