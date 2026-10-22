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
 * npm start -- --open           # 另加：等服务真的就绪后自动打开浏览器
 * npm run dev                   # 构建一次后：serve + 前端 tsc --watch（改前端自动重编，刷新即可）
 * ```
 *
 * ## 设计纪律
 *
 * - **不吞输出**：构建日志与服务端日志都直接继承 stdio（用户要能看见"工作区来自哪个来源"的横幅）。
 * - **Ctrl+C 能停**：前台运行，收到 SIGINT 直接把子进程一起收走（Windows 上 node 会转发给同一控制台进程组）。
 * - **失败即停**：任一步非零退出码立即中止，绝不"构建失败还起服务"（那只会让人对着旧产物调 bug）。
 * - **零第三方依赖**：只用 `node:child_process`，与本仓"依赖按准入"的口径一致。
 * - **`--open` 是"就绪后"打开而不是"起了就"打开**：判据走 `/readyz`（不是恒 200 的 `/healthz`），
 *   且**端口上是别人**时坚决不开浏览器（否则会把别人的页面当成本项目的工作台）；
 *   纯逻辑在 `scripts/lib/launchReadiness.mjs`，由 `tests/unit/launchReadiness.test.ts` 钉住。
 * - **退出码要说人话**：区分"按了 Ctrl+C"与"失败退出"（Windows 双击场景里这是唯一线索）。
 */
import { spawnSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  browserOpenCommand,
  classifyReadyProbe,
  describeReadyOutcome,
  describeServeExit,
  readinessUrl,
  resolveServePort,
  waitForReady,
} from './lib/launchReadiness.mjs';

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

/**
 * 探测一次就绪端点。
 *
 * 超时刻意压到 1s：探针跑在**本地回环**上，秒级无响应就说明"还没起来"，
 * 没必要让每次轮询都拖长——3 分钟总预算里要留足重试次数。
 * @param url 就绪探针地址。
 * @returns 分类标签（`classifyReadyProbe` 的取值）。
 */
async function probeOnce(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
    const bodyText = await response.text().catch(() => '');
    return classifyReadyProbe({ statusCode: response.status, bodyText });
  } catch (error) {
    return classifyReadyProbe({ error });
  }
}

/**
 * 等待服务就绪并打开浏览器（`--open`）。
 *
 * 打印一律**如实**：没就绪就说没就绪，端口被别人占就说是别人占的——"静默什么都不做"
 * 比"没打开浏览器"更难排查（用户只会以为双击没生效）。
 *
 * **必须打开带 token 的 URL**（2026-10-18 修复）：回环 serve 现在默认生成临时令牌，
 * 裸 `http://127.0.0.1:PORT` 会直接 401（设计如此）。serve 启动横幅里的
 * `OmniHarness UI: …?token=…` 是浏览器唯一能凭之换取 HttpOnly cookie 的入口，
 * 所以这里等横幅出现、把那一行**原样**交给浏览器；拿不到才退回裸 URL 并如实告警。
 * @param port 监听端口。
 * @param uiUrlRef 已捕获的带 token UI URL（serve 横幅解析结果；未捕获为 undefined）
 * @returns 无返回值（fire-and-forget，绝不阻塞服务进程）。
 */
async function openWhenReady(port, uiUrlRef) {
  const url = readinessUrl(port);
  const result = await waitForReady({ probe: () => probeOnce(url) });
  process.stdout.write(`\n${describeReadyOutcome(result.outcome, port)}\n`);
  if (result.outcome !== 'ready' && result.outcome !== 'guarded') {
    return;
  }
  // 横幅可能比"就绪"晚几毫秒（listen 回调里才打印）：最多再等 3s。
  const deadline = Date.now() + 3000;
  while (uiUrlRef.value === undefined && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  const page = uiUrlRef.value ?? `http://127.0.0.1:${String(port)}`;
  if (uiUrlRef.value === undefined) {
    process.stderr.write(
      '[omniharness] 未捕获到带 token 的 UI URL：若服务端启用了鉴权，直接打开裸地址会 401。' +
        '请从上面的 `OmniHarness UI:` 行复制地址。\n',
    );
  }
  // `OMNI_NO_OPEN=1` 只压住**弹窗**这一步，不压住"等待 + 如实报告就绪"：
  // 无人值守里真正想要的是"起来了没"这个事实，而不是窗口。
  if (process.env.OMNI_NO_OPEN === '1') {
    process.stdout.write(`[omniharness] OMNI_NO_OPEN=1 ⇒ 已就绪但未打开浏览器：${page}\n`);
    return;
  }
  const opener = browserOpenCommand(process.platform, page);
  if (opener === null) {
    process.stdout.write(`[omniharness] 本平台不支持自动打开浏览器，请手动访问 ${page}\n`);
    return;
  }
  const child = spawn(opener.command, opener.args, { stdio: 'ignore' });
  child.on('error', (error) => {
    process.stderr.write(`[omniharness] 打开浏览器失败：${error.message}（请手动访问 ${page}）\n`);
  });
}

const args = process.argv.slice(2);
const skipBuild = args.includes('--no-build');
const openBrowser = args.includes('--open');
// `--open` / `--no-build` 是**本脚本**的旗标，绝不能透传给 serve：serve 对未知旗标是 fail-closed 退出，
// 透过去就是"启动器自己的便利功能把它自己打死"。
const serveArgs = args.filter((a) => a !== '--no-build' && a !== '--open');

if (!skipBuild) {
  runNpm('build');
  runNpm('web:build');
} else if (!existsSync(SERVE_ENTRY)) {
  process.stderr.write('✗ --no-build 但 dist/ 不存在 ⇒ 先跑一次 npm start（或 npm run build）。\n');
  process.exit(1);
}

// 启动前清一次**超过 7 天**的本仓临时产物（Chrome profile / worktree 副本 / A/B 目录）。
// 只清本仓前缀且超龄，不会碰另一个正在运行的进程；失败只告警，不阻断启动。
try {
  const { TmpSweep } = await import(
    pathToFileURL(join(REPO, 'dist', 'src', 'util', 'tmpSweep.js')).href
  );
  const sweep = TmpSweep.run({ olderThanMs: 7 * 24 * 60 * 60 * 1000 });
  if (sweep.matched.length > 0) {
    process.stdout.write(
      `▶ 清理陈年临时产物：${String(sweep.removed)} 项（扫描 ${String(sweep.scanned)}）\n`,
    );
  }
} catch (error) {
  process.stderr.write(`[tmp-sweep] 跳过（${String(error)}）\n`);
}

process.stdout.write('\n▶ serve（Ctrl+C 停止）\n\n');
const child = spawn(process.execPath, [SERVE_ENTRY, 'serve', ...serveArgs], {
  cwd: process.cwd(),
  // stdout 改成 pipe：需要**边转发边解析**启动横幅里的 `?token=` URL（浏览器唯一可用入口）。
  // stderr 保持继承（日志/警告原样直出，不参与解析）。
  stdio: ['inherit', 'pipe', 'inherit'],
});
/** serve 横幅里的 UI URL（带临时 token；未捕获前为 undefined）。 */
const uiUrlRef = { value: undefined };
child.stdout.on('data', (chunk) => {
  const text = chunk.toString('utf8');
  process.stdout.write(text);
  if (uiUrlRef.value === undefined) {
    const match = text.match(/https?:\/\/[^\s]+\?token=[0-9a-fA-F]+/u);
    if (match !== null) uiUrlRef.value = match[0];
  }
});
if (openBrowser) {
  void openWhenReady(resolveServePort(serveArgs), uiUrlRef);
}
child.on('exit', (code) => {
  process.stdout.write(`\n${describeServeExit(code)}\n`);
  process.exit(code ?? 0);
});
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => child.kill(sig));
}
