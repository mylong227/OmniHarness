import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * 直接用平台 esbuild 二进制（不走 JS API）：JS API 会 spawn 常驻 service，
 * 在受限环境里会 EPERM；直接二进制 + stdio inherit 在本机/CI 都稳。
 */
const esbuildBin =
  process.env['ESBUILD_BINARY_PATH'] ??
  join(
    root,
    'node_modules',
    `@esbuild/${process.platform}-${process.arch}`,
    process.platform === 'win32' ? 'esbuild.exe' : 'bin/esbuild',
  );
if (!existsSync(esbuildBin)) {
  throw new Error(`esbuild 二进制不存在：${esbuildBin}`);
}

/**
 * 构建一个入口（CJS；Electron 主进程/沙箱 preload 均用 CJS 最稳）。
 * @param entry 入口相对路径。
 * @param outfile 输出相对路径。
 * @returns 无返回值。
 */
function bundle(entry, outfile) {
  const result = spawnSync(
    esbuildBin,
    [
      entry,
      '--bundle',
      '--platform=node',
      '--target=node22',
      '--format=cjs',
      '--sourcemap',
      `--outfile=${outfile}`,
      '--external:electron',
      '--external:electron-updater',
      '--log-level=info',
    ],
    { cwd: root, stdio: 'inherit' },
  );
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(
      `esbuild 失败：${entry}（${result.error?.message ?? `exit ${String(result.status)}`}）`,
    );
  }
}

mkdirSync(join(root, 'dist'), { recursive: true });
bundle('src/main/main.ts', 'dist/main.cjs');
bundle('src/preload/preload.ts', 'dist/preload.cjs');
cpSync(join(root, 'static'), join(root, 'dist'), { recursive: true });
console.log('[desktop] built dist/main.cjs + dist/preload.cjs + static assets');
