#!/usr/bin/env node
/**
 * 前端开发回路：**构建一次 → 并行起 serve 与 `web:watch`**（改前端自动重编，浏览器刷新即见）。
 *
 * ## 与本仓构建形态的关系（为什么不是 Vite/热更新）
 *
 * 本仓前端是**零打包器**的原生 ESM：`web/index.html` 直接加载 `web/dist/main.js`，由
 * `tsc -p web/tsconfig.json` 产出。因此"热更新"在这里的等价物就是 `tsc --watch` + 浏览器刷新
 * （`index.html` 已给模块 URL 加时间戳，避免命中旧缓存）。不引入打包器是本仓的既有取舍，
 * 本脚本只把这条回路固化，不改变形态。
 *
 * ## 用法
 *
 * ```bash
 * npm run dev                    # serve（默认端口 8787）+ 前端 watch
 * npm run dev -- --port 9000     # 参数透传给 serve
 * ```
 *
 * 后端改动（`src/**`）**不在**本回路的监听范围内：改完后端要重新 `npm run build` 并重启
 * （serve 是常驻进程，不会自己换掉已加载的 JS）。这是刻意的取舍——前端改得频繁，后端改得少。
 */
import { spawn, spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const isWin = process.platform === 'win32';
const npm = isWin ? 'npm.cmd' : 'npm';
/** Windows 上 `npm.cmd` 必须经 shell 启动（Node 的 `.cmd` 防护，见 `startAll.mjs` 同名注释）。 */
const npmOpts = { cwd: REPO, stdio: 'inherit', ...(isWin ? { shell: true } : {}) };

process.stdout.write('\n▶ 首次构建（服务端 + 前端）\n');
for (const script of ['build', 'web:build']) {
  const r = spawnSync(npm, ['run', script], npmOpts);
  if (r.status !== 0) {
    const why = r.error !== undefined ? `：${r.error.message}` : '';
    process.stderr.write(
      `\n✗ npm run ${script} 失败（退出码 ${r.status ?? 'null'}）${why} ⇒ 已中止。\n`,
    );
    process.exit(r.status ?? 1);
  }
}

const serveArgs = process.argv.slice(2);
process.stdout.write('\n▶ serve + web:watch（Ctrl+C 停止两者）\n\n');
const children = [
  spawn(process.execPath, [join(REPO, 'dist', 'src', 'cli', 'exec.js'), 'serve', ...serveArgs], {
    cwd: process.cwd(),
    stdio: 'inherit',
  }),
  spawn(npm, ['run', 'web:watch'], npmOpts),
];

let stopping = false;
/**
 * 把两个子进程一起收走（任何一个先退出都不留孤儿进程）。
 * @param {number} code 退出码。
 * @returns {void}
 */
function stopAll(code) {
  if (stopping) return;
  stopping = true;
  for (const c of children) if (c.exitCode === null) c.kill();
  process.exit(code);
}
for (const c of children) c.on('exit', (code) => stopAll(code ?? 0));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => stopAll(0));
