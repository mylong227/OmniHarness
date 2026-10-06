#!/usr/bin/env node
/**
 * 一键启动：**构建前后端 → 起 HTTP UI 服务**（本仓唯一推荐的整体启动方式）。
 *
 * ## 为什么需要它（而不是让用户手敲三条命令）
 *
 * 本仓的前端**没有打包器、也没有 dev server**：`web/index.html` 直接 `<script type="module">` 加载
 * `web/dist/main.js`，而那是由 `tsc -p web/tsconfig.json` 编出来的。于是"把工作台跑起来"其实是三件事：
 * ① 编服务端（`dist/`）；② 编前端（`web/dist/`）；③ 起 `serve`（静态资源取自仓库 `web/`）。
 * 少任何一步都会出现"能打开页面但一片空白"或"页面里的交互没生效"这类**看起来像 bug 的缺失构建**。
 * 故把它固化成一个入口，并让**参数透传**给 `serve`（`npm start -- --port 9000`）。
 *
 * ## 用法
 *
 * ```bash
 * npm start                     # 构建 + 起服务（默认端口 8787）
 * npm start -- --port 9000      # 透传任意 serve 参数
 * npm start -- --mock           # 零 API Key 的 mock 演示
 * npm start -- --workspace D:/work/新项目
 * npm run dev                   # 构建一次后：serve + 前端 tsc --watch（改前端自动重编，刷新即可）
 * ```
 *
 * ## 设计纪律
 *
 * - **不吞输出**：构建日志与服务端日志都直接继承 stdio（用户要能看见"工作区来自哪个来源"的横幅）。
 * - **Ctrl+C 能停**：前台运行，收到 SIGINT 直接把子进程一起收走（Windows 上 node 会转发给同一控制台进程组）。
 * - **失败即停**：任一步非零退出码立即中止，绝不"构建失败还起服务"（那只会让人对着旧产物调 bug）。
 * - **零第三方依赖**：只用 `node:child_process`，与本仓"依赖按准入"的口径一致。
 */
import { spawnSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVE_ENTRY = join(REPO, 'dist', 'src', 'cli', 'exec.js');

/**
 * 跑一条 npm 脚本，失败即抛。
 *
 * **Windows 上必须 `shell: true`**：Node 自 2024 起（CVE-2024-27980 缓解）禁止不经 shell 直接 spawn
 * `.cmd`/`.bat`，于是 `spawnSync('npm.cmd', …)` 会**静默失败**（`status === null`、无任何输出）——
 * 本脚本第一版就踩了这个坑：`npm start` 只打印"npm run build 失败（退出码 null）"便中止。
 * @param {string} script 脚本名（如 'build'）。
 * @returns {void}
 */
function runNpm(script) {
  process.stdout.write(`\n▶ npm run ${script}\n`);
  const isWin = process.platform === 'win32';
  const r = spawnSync(isWin ? 'npm.cmd' : 'npm', ['run', script], {
    cwd: REPO,
    stdio: 'inherit',
    shell: isWin,
  });
  if (r.status !== 0) {
    const why = r.error !== undefined ? `：${r.error.message}` : '';
    process.stderr.write(
      `\n✗ npm run ${script} 失败（退出码 ${r.status ?? 'null'}）${why} ⇒ 已中止，不启动服务。\n`,
    );
    process.exit(r.status ?? 1);
  }
}

const args = process.argv.slice(2);
const skipBuild = args.includes('--no-build');
const serveArgs = args.filter((a) => a !== '--no-build');

if (!skipBuild) {
  runNpm('build');
  runNpm('web:build');
} else if (!existsSync(SERVE_ENTRY)) {
  process.stderr.write('✗ --no-build 但 dist/ 不存在 ⇒ 先跑一次 npm start（或 npm run build）。\n');
  process.exit(1);
}

process.stdout.write('\n▶ serve（Ctrl+C 停止）\n\n');
const child = spawn(process.execPath, [SERVE_ENTRY, 'serve', ...serveArgs], {
  cwd: process.cwd(),
  stdio: 'inherit',
});
child.on('exit', (code) => process.exit(code ?? 0));
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => child.kill(sig));
}
