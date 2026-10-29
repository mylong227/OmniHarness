#!/usr/bin/env node
/**
 * 前端开发回路：**后端 serve + Vite dev server（HMR）**。
 *
 * ## 与旧形态的区别（2026-10-17 迁移到 Vite）
 *
 * 旧形态是「零打包器」：`tsc --watch` 重编原生 ESM，改前端后**手动刷新**浏览器。
 * 现在是标准 Vite 项目：`vite` 起 dev server（默认 5173），改前端**热更新**（HMR，不丢组件状态）。
 *
 * 两个进程各司其职：
 *   · 后端 `serve`（默认 8787）：RPC + SSE + 文件下载；
 *   · Vite dev server（默认 5173）：转译 TS/TSX、HMR，并把 `/rpc` `/events` `/files`
 *     **代理**到后端（见 `vite.config.ts` 的 `server.proxy`）。
 *
 * ⚠️ 开发时请访问 **Vite 的地址**（`http://localhost:5173`），不是后端那个端口——
 * 后端只提供 API 与「已构建的产品页」，改源码不会反映到它上面（除非重跑 `npm run web:build`）。
 *
 * ## 用法
 *
 * ```bash
 * npm run dev                    # 后端 serve + Vite dev server
 * npm run dev -- --port 9000     # 参数透传给 serve（Vite 端口由 vite.config.ts 决定）
 * ```
 *
 * 后端改动（`src/**`）**不在**本回路的监听范围内：改完后端要重新 `npm run build` 并重启
 * （serve 是常驻进程，不会自己换掉已加载的 JS）。这是刻意取舍——前端改得频繁，后端改得少。
 *
 * 端口约定（2026-10-30 收口，看板 §182）：**全部走 `scripts/devConfig.mjs` 唯一事实源**——
 *   · 默认值：后端 8787 / Vite 5173（devConfig 的 DEV_DEFAULTS，与后端 serveDefaults 互为镜像）；
 *   · 环境变量：`OMNI_BACKEND_PORT`（后端端口，serve 与 vite 代理同读）、
 *     `OMNI_UI_PORT`（Vite dev server 端口；旧名 `OMNI_FRONTEND_PORT` 仍认）；
 *   · 透传的 `--port N`（给 serve）优先级最高：本脚本会把它同步进 `OMNI_BACKEND_PORT`，
 *     保证 vite 代理指向**实际监听**的端口——此前两边默认值各自写死，环境变量只改一边就断裂。
 */
import { spawn, spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDevAddress } from './devConfig.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const isWin = process.platform === 'win32';
const npm = isWin ? 'npm.cmd' : 'npm';
/** Windows 上 `npm.cmd` 必须经 shell 启动（Node 的 `.cmd` 防护，见 `startAll.mjs` 同名注释）。 */
const npmOpts = { cwd: REPO, stdio: 'inherit', ...(isWin ? { shell: true } : {}) };

process.stdout.write('\n▶ 首次构建（仅服务端；前端由 Vite dev server 现编）\n');
const built = spawnSync(npm, ['run', 'build'], npmOpts);
if (built.status !== 0) {
  const why = built.error !== undefined ? `：${built.error.message}` : '';
  process.stderr.write(
    `\n✗ npm run build 失败（退出码 ${built.status ?? 'null'}）${why} ⇒ 已中止。\n`,
  );
  process.exit(built.status ?? 1);
}

const serveArgs = process.argv.slice(2);
// 端口契约（见文件头）：透传的 `--port N` 优先；否则注入 devConfig 解析的后端端口，
// 并把最终端口写进环境变量——vite 子进程经 vite.config 的 resolveDevAddress 读到**同一个值**。
const userPort = serveArgs.includes('--port')
  ? (serveArgs[serveArgs.indexOf('--port') + 1] ?? '')
  : (serveArgs.find((a) => a.startsWith('--port='))?.slice('--port='.length) ?? '');
const dev = resolveDevAddress(
  userPort !== '' ? { ...process.env, OMNI_BACKEND_PORT: userPort } : process.env,
);
const finalServeArgs =
  userPort !== '' ? serveArgs : ['--port', String(dev.backendPort), ...serveArgs];
process.env.OMNI_BACKEND_PORT = String(dev.backendPort);
process.env.OMNI_UI_PORT = String(dev.uiPort);
process.stdout.write(
  `\n▶ 后端 http://${dev.host}:${String(dev.backendPort)} · Vite http://${dev.host}:${String(dev.uiPort)}（地址来源 scripts/devConfig.mjs）\n`,
);
process.stdout.write('\n▶ 后端 serve + Vite dev server（Ctrl+C 停止两者）\n\n');
const children = [
  spawn(
    process.execPath,
    [join(REPO, 'dist', 'src', 'cli', 'exec.js'), 'serve', ...finalServeArgs],
    {
      cwd: process.cwd(),
      stdio: 'inherit',
    },
  ),
  spawn(npm, ['run', 'web:dev'], npmOpts),
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
