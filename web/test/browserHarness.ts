// 共享浏览器验证工具（E1 CDP 路线；**无第三方依赖**，不引入 playwright / puppeteer / ws / CDP 库）。
//
// 与 D3 的 UI e2e（`web/test/e2e.test.mjs`）**同一传输**：复用本机已装 Chrome/Edge，
// 用无第三方依赖 Node http 静态服务托管 web/，并注入假 /rpc + 假 /events 使前端在确定性假后端下渲染。
// 本文件在其上新增 **CDP 路线**：用 Node 22 内置全局 `WebSocket` 直连 Chrome DevTools Protocol，
// 做「截图 → 视觉核对 → 操作回环」一例（E1 的可证伪验收）。
//
// 无浏览器时调用方应显式 skip（不伪装通过）；可用 OMNI_CHROME_PATH 指定可执行文件。

import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createNetServer } from 'node:net';
import { requireBrowser } from './browserSwitch.ts';
import { makeOmniTemp, rmRfRetry } from './omniTemp.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(HERE, '..');
const INDEX_HTML = join(WEB_ROOT, 'index.html');

/** 候选浏览器可执行文件（env 覆盖优先；Windows / macOS / Linux 三平台）。 */
const BROWSER_CANDIDATES: (string | undefined)[] = [
  process.env.OMNI_CHROME_PATH,
  process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : '',
  process.platform === 'win32' ? 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe' : '',
  process.platform === 'win32' && process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe')
    : '',
  process.platform === 'win32' ? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' : '',
  process.platform === 'win32' ? 'C:/Program Files/Microsoft/Edge/Application/msedge.exe' : '',
  process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '',
  process.platform === 'darwin' ? '/Applications/Chromium.app/Contents/MacOS/Chromium' : '',
  process.platform === 'linux' ? '/usr/bin/google-chrome' : '',
  process.platform === 'linux' ? '/usr/bin/google-chrome-stable' : '',
  process.platform === 'linux' ? '/usr/bin/chromium' : '',
  process.platform === 'linux' ? '/usr/bin/chromium-browser' : '',
].filter((p) => p !== '');

/** 选择本机可用浏览器；无则 null。 @returns 可执行文件绝对路径或 null */
/**
 * 选择本机可用浏览器；无则 null。
 *
 * `OMNI_BROWSER_NONE=1` 是**测试钩子**（2026-10-11）：本机永远有 Chrome 时，"没有浏览器"这条分支
 * 从来跑不到 ⇒ `OMNI_REQUIRE_BROWSER` 开关的**失败路径**等于没验过。钩子让判据能端到端构造该场景
 * （见 `web/test/browserSwitch.test.mjs` ④：关掉开关应 skip、打开开关必须失败）。
 * @returns 可执行文件绝对路径或 null
 */
export function findBrowser() {
  if (process.env.OMNI_BROWSER_NONE === '1') {
    return null;
  }
  for (const candidate of BROWSER_CANDIDATES) {
    if (candidate !== undefined && existsSync(candidate)) return candidate;
  }
  return null;
}

/** 静态资源 MIME 表（模块加载对 MIME 敏感，缺失会导致 app 静默不启动）。 */
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.map': 'application/json; charset=utf-8',
};

/** serveStatic 的句柄：随机端口与关闭器。 */
export interface StaticServerHandle {
  port: number;
  close: () => Promise<void>;
}

/**
 * 无第三方依赖静态服务（127.0.0.1 随机端口），托管 web/ 目录，并把内存路由注入。
 * @param {string} root 站点根目录
 * @param {Record<string, string>} memoryRoutes 内存路由（路径 → HTML 文本）
 * @returns {Promise<StaticServerHandle>} 端口与关闭器
 */
export function serveStatic(root: string, memoryRoutes: Record<string, string>): Promise<StaticServerHandle> {
  const server = createServer((req, res) => {
    const rawPath = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/');
    const html = memoryRoutes[rawPath];
    if (html !== undefined) {
      // MIME **按扩展名**给，不能一律 text/html：内存路由也用来替换 `.js` 模块（如给某个组件注入
      // 一个渲染期抛错的版本，用于验证错误边界）。模块脚本的 MIME 是**强校验**的——发成 text/html
      // 浏览器会拒绝执行该模块，整个 import 图随之失败（表现是 `Failed to fetch dynamically imported
      // module: /dist/main.js` + 页面空白），看起来像「被测代码崩了」，其实是夹具把模块图弄坏了。
      res.writeHead(200, {
        'content-type': MIME[extname(rawPath).toLowerCase()] || 'text/html; charset=utf-8',
      });
      res.end(html);
      return;
    }
    const rel = rawPath === '/' ? 'index.html' : rawPath.replace(/^\/+/, '');
    const target = normalize(join(root, rel));
    if (!target.startsWith(normalize(root))) {
      res.writeHead(403).end('forbidden');
      return;
    }
    let body;
    try {
      body = readFileSync(target);
    } catch {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[extname(target).toLowerCase()] || 'application/octet-stream' });
    res.end(body);
  });
  return new Promise<StaticServerHandle>((res) => {
    server.listen(0, '127.0.0.1', () => {
      res({
        // listen(0, '127.0.0.1') 的成功回调里 address() 必为 AddressInfo（lib 类型是三态联合）。
        port: (server.address() as import('node:net').AddressInfo).port,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

/**
 * 注入脚本体内（假 /rpc + 假 /events + 自诊断 + 钩子）。与 e2e.test.mjs 同源，保证同一套假后端。
 * 内含 `scenario` 定义但与 D3 不同：CDP 路线**不自动跑**场景，页面挂载后仅置 `window.__READY__`，
 * 由 CDP 驱动外部操作（键入 / 点击 / 推事件）。钩子 `window.__RPC_CALLS__` / `window.__PUSH__` / `window.__RESOLVE_TURN__` 仍暴露。
 * @returns {string} IIFE 体内 JS（不含外层 <script> 标签）
 */
function injectedBody() {
  return [
    '(function(){',
    '  var RPC_CALLS = []; window.__RPC_CALLS__ = RPC_CALLS;',
    '  var SOURCES = []; window.__SOURCES__ = SOURCES;',
    '  var json = function(o){ return { ok:true, status:200, json:function(){ return Promise.resolve(o); }, text:function(){ return Promise.resolve(JSON.stringify(o)); } }; };',
    '  var results = {',
    "    'model.catalog': { providers: [], active: { id:'mock', label:'Mock 厂商', defaultModel:'mock-e2e', model:'mock-e2e', models:['mock-e2e'], reasoningEffort:['low','medium','high'] } },",
    // 夹具自洽性（2026-10-17 修）：`reasoning` 必须**属于**上面的 reasoningEffort，
    // 否则模型弹窗的进度条会把"当前值"当一个不属于该模型的档位追加在末尾，
    // 截图里读起来就是"弱 / 强 / 中"这种乱序（不是渲染 bug，是夹具自相矛盾）。
    // reasoningEffort 的真实形状见 ApiClient.ModelCatalog.reasoningEffort。
    "    'config.get': { modelAdapter:'mock', model:'mock-e2e', reasoning:'medium', approval:'ask' },",
    "    'sessions.list': { dir:'', sessions: [] },",
    "    'workspace.list': { current:'', workspaces: [] },",
    "    'fs.list': { tree: [] },",
    "    'approval.tiers': { tiers: [] },",
    "    'changes.list': { files: [] },",
    "    'usage.stats': { source:'live', dir:'', byModel:{}, total:{calls:0,prompt:0,completion:0,total:0}, sessions:[] },",
    "    'context.usage': { threadId:'', windowTokens:0, usedTokens:0, percent:0, rows:[], mcpToolCount:0, systemToolCount:0, source:'empty', cache:{ hitRate:0, calls:0 }, collectedAt:'' },",
    // 配额：**形状必须完整**——`QuotaView` 会直接读 `status.plan.upgraded` 与 `status.models.map`，
    // 形状不符（旧版服务端无该方法 ⇒ 回落 `{}`）会在渲染期抛错并把整个工作台卸载（root 清空）。
    "    'quota.get': { plan:{ id:'plus', label:'升级', multiplier:1.5, upgraded:true }, planReason:'通用主力命名（chat / standard / base / v<N>）', planModel:'mock-e2e', dailyTokens:1000000, effectiveTokens:1000000, usedTokens:0, remainingPercent:100, models:[], dayKey:'1970-01-01', resetAt:'1970-01-01T23:59:59.999Z', source:'local-budget' },",
    // 添加菜单要这两项（插件/智能体目录）：缺失时旧实现会把 undefined 塞进 state，点＋即整块输入区
    // 崩掉卸载（2026-09-27 实测）⇒ stub 必须给**正确形状**，否则弹层类用例根本测不到渲染。
    "    'plugins.list': { plugins: [] },",
    "    'agents.list': { agents: [] },",
    "    'modes.get': { goal:'', planMode:false, sketchMode:false },",
    "    'approval.respond': { ok:true },",
    // 提问上行（2026-10-08）：与 approval.respond 同形——缺了它，提问卡的提交流程会拿到 `{}`，
    // 而 `ok` 缺失按「被拒」处理（挂起保留、卡片不收起），于是**任何**提问类的浏览器验收都会假红。
    "    'question.respond': { ok:true },",
    "    'turns.run': { pending:true }",
    '  };',
    // 运行期结果覆盖（**纯增量**，不影响任何既有用例）：页面可在本脚本之前先挂
    // `window.__RPC_OVERRIDES__ = { '方法名': 结果 }`，用真实业务形状的数据驱动界面，
    // 例如视觉探针要看到"有会话/有变更/有指标"的完整工作台。缺省路径逐字不变。
    '  var OVERRIDES = window.__RPC_OVERRIDES__ || {};',
    '  for (var ok in OVERRIDES) { if (Object.prototype.hasOwnProperty.call(OVERRIDES, ok)) results[ok] = OVERRIDES[ok]; }',
    '  window.fetch = function(url, opts){',
    "    var u = String(url);",
    "    var method = '';",
    '    try { method = JSON.parse((opts && opts.body) || "{}").method || ""; } catch(e) {}',
    "    if (u.indexOf('/rpc') >= 0) {",
    '      var id = 0; try { id = JSON.parse(opts.body).id; } catch(e) {}',
    '      RPC_CALLS.push({ method: method });',
    "      if (method === 'turns.run') { return new Promise(function(resolveTurn){ window.__RESOLVE_TURN__ = function(r){ resolveTurn(json({ jsonrpc:'2.0', id:id, result: r })); }; }); }",
    "      var body = results[method] !== undefined ? results[method] : {};",
    "      return Promise.resolve(json({ jsonrpc:'2.0', id:id, result: body }));",
    '    }',
    "    return Promise.resolve(json({}));",
    '  };',
    '  window.EventSource = function(url){',
    '    var self = this; self.url = url; self.readyState = 0; self.onopen = null; self.onerror = null; self.onmessage = null;',
    '    SOURCES.push(self);',
    "    setTimeout(function(){ self.readyState = 1; if (self.onopen) self.onopen({}); }, 0);",
    '  };',
    '  window.EventSource.prototype.close = function(){ this.readyState = 2; };',
    '  var push = function(env){',
    '    for (var i = 0; i < SOURCES.length; i++) {',
    "      var es = SOURCES[i]; if (es.onmessage) es.onmessage({ data: JSON.stringify(env) });",
    '    }',
    '  };',
    '  window.__PUSH__ = push;',
    '  var steps = [];',
    '  var ok = function(name, cond){ steps.push({ name: name, ok: !!cond }); return !!cond; };',
    '  var DIAG = { errors: [], stacks: [], console: [] };',
    '  window.addEventListener("error", function(e){ DIAG.errors.push(String((e && e.message) || e)); if (e && e.error && e.error.stack) DIAG.stacks.push(String(e.error.stack)); });',
    '  window.addEventListener("unhandledrejection", function(e){ DIAG.errors.push("rejection: " + String((e && e.reason && e.reason.message) || (e && e.reason))); if (e && e.reason && e.reason.stack) DIAG.stacks.push(String(e.reason.stack)); });',
    '  var _consoleError = console.error;',
    '  console.error = function(){ DIAG.console.push(Array.prototype.join.call(arguments, " ")); return _consoleError.apply(console, arguments); };',
    '  var sleep = function(ms){ return new Promise(function(r){ setTimeout(r, ms); }); };',
    '  var until = function(pred, tries){',
    '    return (function loop(n){',
    '      if (pred()) return Promise.resolve(true);',
    '      if (n <= 0) return Promise.resolve(false);',
    '      return sleep(0).then(function(){ return loop(n - 1); });',
    '    })(tries || 400);',
    '  };',
    '  var q = function(sel){ return document.querySelector(sel); };',
    '  var scenario = function(){',
    "    var ta, send;",
    "    return until(function(){ return q('.composer-input textarea') && q('button.send'); }, 800)",
    "      .then(function(mounted){ if (!ok('app mounted', mounted)) throw new Error('app 未挂载'); ta = q('.composer-input textarea'); send = q('button.send'); ta.value = '给我写一个文件'; send.click(); return until(function(){ return RPC_CALLS.some(function(c){ return c.method === 'turns.run'; }); }, 600); })",
    "      .then(function(dispatched){ ok('turn dispatched', dispatched); return until(function(){ return SOURCES.length > 0; }, 400); })",
    "      .then(function(connected){ ok('sse connected', connected); push({ method:'thread.text_delta', params:{ text:'正在' } }); push({ method:'thread.text_delta', params:{ text:'分析…' } }); return until(function(){ return !!q('.streaming-assistant .content'); }, 400); })",
    "      .then(function(shown){ ok('streaming card visible', shown); var c = q('.streaming-assistant .content'); ok('streaming text merged', c && c.textContent === '正在分析…'); push({ method:'approval.request', params:{ requestId:'r1', toolName:'shell', target:'rm -rf /tmp/x' } }); return until(function(){ return !!q('.overlay.show .modal[role=\"dialog\"]'); }, 400); })",
    "      .then(function(shown){ ok('approval modal visible', shown); var allow = q('.overlay.show .modal .allow'); ok('approval allow button', !!allow); if (allow) allow.click(); return until(function(){ return RPC_CALLS.some(function(c){ return c.method === 'approval.respond'; }); }, 400); })",
    "      .then(function(sent){ ok('approval responded', sent); push({ method:'thread.event', params:{ event:{ id:'e1', sessionId:'s1', type:'tool_call', timestamp:1, payload:{ callId:'c1', name:'write_file', args:{ path:'src/demo.ts', content:'export const x = 1;' } } } } }); push({ method:'thread.event', params:{ event:{ id:'e2', sessionId:'s1', type:'tool_result', timestamp:2, payload:{ callId:'c1', ok:true, text:'已写入 src/demo.ts' } } } }); return true; })",
    "      .then(function(){ if (window.__RESOLVE_TURN__) window.__RESOLVE_TURN__({ threadId:'s1', finalText:'', steps:1 }); push({ method:'thread.event', params:{ event:{ id:'e3', sessionId:'s1', type:'assistant', timestamp:3, payload:{ content:'正在分析…' } } } }); push({ method:'thread.event', params:{ event:{ id:'e4', sessionId:'s1', type:'turn_diff', timestamp:4, payload:{ diff:'--- a/src/demo.ts\\n+++ b/src/demo.ts\\n@@ -0,0 +1,1 @@\\n+export const x = 1;' } } } }); return until(function(){ return !!q('.turn-summary .ts-file'); }, 600); })",
    "      .then(function(shown){ ok('turn summary visible', shown); var n = q('.turn-summary .ts-name'); ok('summary file name', n && n.textContent === 'demo.ts'); var href = q('.turn-summary .ts-actions a'); ok('summary download link', href && href.getAttribute('href') === '/files?path=src%2Fdemo.ts'); return until(function(){ return !!q('.ev.assistant .card.assistant .content'); }, 400); })",
    "      .then(function(shown){ ok('final assistant card', shown); });",
    '  };',
    '  window.__READY__ = true;',
    '})();',
  ].join('\n');
}

/**
 * 生成 CDP 路线 stub 页：注入假后端并挂载 app，但**不自动跑场景**，由 CDP 驱动操作。
 * @returns {string} 完整 HTML 文本
 */
export function stubHtmlCdp() {
  // 2026-10-17 迁移到 Vite 后：宿主页必须取**构建产物** `web/dist/index.html`。
  //
  // 为什么不能再用 `web/index.html`：它是 Vite 的**源码入口**（`<script type="module"
  // src="./src/main.ts">`），需要 Vite 转译；探针用 `serveStatic` 托管静态文件、不跑转译管线，
  // 于是模块 404 ⇒ 页面白屏 ⇒ 所有浏览器判据拿到 null。实测形态正是
  // `{"leftWidth":null,"centerWidth":null,...}`，看起来像"左栏没渲染"，实为没加载。
  //
  // 两个必要处理：
  //   ① 宿主改读 `dist/index.html`（Vite 已转译 + 单 bundle）；
  //   ② 注入 `<base href="/dist/">` —— 产物里的资源是**相对路径**（`./assets/*`，
  //      为支持子路径部署），而 stub 页挂在站点根（`/_xxx.html`），
  //      相对解析会指向 `/assets/*`（实测 404）。加 `<base>` 后一律解析到 `/dist/assets/*`。
  const distIndex = join(WEB_ROOT, 'dist', 'index.html');
  const index = readFileSync(existsSync(distIndex) ? distIndex : INDEX_HTML, 'utf8');
  const withBase = index.replace('<head>', '<head>\n  <base href="/dist/">');
  const injected = '<script>\n' + injectedBody() + '\n</script>';
  return withBase.replace('<div id="root"></div>', '<div id="root"></div>\n' + injected);
}

/** 取一个空闲本地端口（供 Chrome `--remote-debugging-port` 使用）。 @returns {Promise<number>} */
export function getFreePort(): Promise<number> {
  return new Promise<number>((res, rej) => {
    const s = createNetServer();
    s.listen(0, '127.0.0.1', () => {
      // listen(0) 的成功回调里 address() 必为 AddressInfo（lib 类型是三态联合）。
      const port = (s.address() as import('node:net').AddressInfo).port;
      s.close(() => res(port));
    });
    s.on('error', rej);
  });
}

/**
 * 以 CDP 模式启动 headless Chrome（不写 DOM，开远程调试端口）。
 * @param {string} browser 浏览器可执行文件
 * @param {string} url 启动页地址
 * @param {string} userDataDir 独立用户数据目录
 * @param {number} port 远程调试端口
 * @returns {import('node:child_process').ChildProcess} Chrome 子进程
 */
export function launchChromeForCdp(browser: string, url: string, userDataDir: string, port: number) {
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--no-sandbox',
    '--no-proxy-server',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--disable-crash-reporter',
    '--disable-breakpad',
    '--user-data-dir=' + userDataDir,
    '--window-size=1280,860',
    '--remote-debugging-port=' + port,
    url,
  ];
  return spawn(browser, args, { stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * 终止**整棵** Chrome 进程树（收尾必须走这里，不能只 `child.kill`）。
 *
 * 为什么（2026-09-27 逐条实测）：
 * 1. Windows 上 `spawn(browser, …)` 拿到的 pid 是**启动器 stub**——它把真浏览器作为子进程拉起后
 *    **立刻退出**（实测 `child.exitCode === 0`）。于是收尾时的 `child.kill('SIGKILL')` 打在一个
 *    已不存在的进程上，真浏览器 + 它的 `--type=renderer|gpu-process|…` 后代**全部留下且不会自杀**。
 * 2. 也**不能**靠 `taskkill /PID <child.pid> /T /F` 补救：父进程已死 ⇒ 实测报
 *    `ERROR: The process "<pid>" not found`（退出码 128），/T 无从遍历。逐次实测：kill 前该
 *    user-data-dir 下 12 个 chrome.exe，`child.kill` 后**残留 9–10 个**，再对**残留 pid** 逐个
 *    `taskkill /T /F` 才归零。
 * 3. 故正确做法 = 按**唯一 `--user-data-dir` 标记**扫出这些进程再逐个整树终止（每个用例都用
 *    `mkdtempSync` 造独立目录，标记天然唯一）。
 *
 * 代价与取舍：Windows 上要起一次 PowerShell CIM 查询（`wmic` 在新版 Windows 已移除，不能用），
 * 数百毫秒，只在收尾路径。**同步**执行是刻意的：调用方紧接着要删 `--user-data-dir`，异步终止会让
 * 句柄多存活一会儿 ⇒ `rmSync` 撞 EBUSY（此前 e2e 用例一直打印「临时 profile 目录清理失败」即此）。
 *
 * 平台策略与仓内 `src/adapters/tool/shell/processTreeKiller.ts` 同源（那边注释解释同一取舍）；
 * 此处**刻意不 import dist**：`web:test` 只跑 `web:build`（CI 的 web job 没有后端构建产物），
 * 依赖 dist 会让浏览器用例在 CI 的 web job 里直接崩掉。
 *
 * @param {import('node:child_process').ChildProcess | undefined} child launchChromeForCdp 的返回值
 * @param {string} [userDataDir] 该次启动用的 `--user-data-dir`（唯一标记；缺省时退化为单进程 kill）
 * @returns {void}
 */
export function killChromeTree(child: import('node:child_process').ChildProcess | undefined, userDataDir?: string) {
  // Windows 必须**先** taskkill /T：先 child.kill 会把启动器杀掉，树杀随之失去根，
  // 残留的 renderer/gpu 只能靠 WMI 标记扫描兜底；而 WMI 在进程多时会超时静默返回空。
  if (process.platform === 'win32' && child?.pid !== undefined) {
    try {
      execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        timeout: 8000,
        windowsHide: true,
      });
    } catch {
      /* 启动器可能已退出；下面 child.kill + 标记扫描兜底 */
    }
  }
  // 启动器（可能早已退出；幂等，失败忽略）。
  try {
    child?.kill('SIGKILL');
  } catch {
    /* 已退出 */
  }
  // 真浏览器及其后代：按唯一 user-data-dir 标记扫（见上「为什么不能靠父链」）。
  if (typeof userDataDir !== 'string' || userDataDir === '') return;
  for (const pid of chromePidsWithMarker(userDataDir)) {
    if (process.platform === 'win32') {
      try {
        execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
          stdio: 'ignore',
          timeout: 8000,
          windowsHide: true,
        });
      } catch {
        /* 已退出 / 权限不足：尽力而为，不假装成功 */
      }
      continue;
    }
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* 已退出 */
    }
  }
}

/**
 * 列出命令行包含 `marker` 的 Chrome 进程 pid。
 *
 * 仅用于收尾清理/回归断言；失败一律返回空数组（清理属收尾路径，不因环境异常抛错）。
 * @param {string} marker 命令行子串（这里是唯一的 `--user-data-dir` 路径）
 * @returns {number[]} 命中进程的 pid
 */
function chromePidsWithMarker(marker: string): number[] {
  try {
    if (process.platform === 'win32') {
      const script =
        "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | " +
        'Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress';
      const raw = execFileSync('powershell', ['-NoProfile', '-Command', script], {
        encoding: 'utf8',
        timeout: 60000,
        windowsHide: true,
      }).trim();
      if (raw === '') return [];
      const parsed = JSON.parse(raw);
      const list = Array.isArray(parsed) ? parsed : [parsed];
      return list
        .filter((p) => String(p.CommandLine ?? '').includes(marker))
        .map((p) => Number(p.ProcessId))
        .filter((pid) => Number.isInteger(pid) && pid > 0);
    }
    const raw = execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8', timeout: 15000 });
    return raw
      .split('\n')
      .filter((line) => line.includes(marker))
      .map((line) => Number(line.trim().split(/\s+/)[0]))
      .filter((pid) => Number.isInteger(pid) && pid > 0);
  } catch {
    return [];
  }
}

/**
 * 轮询 Chrome `/json`，取与本页匹配的 page target 的 WebSocket 调试地址。
 * @param {number} port 远程调试端口
 * @param {string} marker 启动 URL 路径标记（用于匹配 page target）
 * @param {number} [timeoutMs] 超时
 * @returns {Promise<string>} page target 的 webSocketDebuggerUrl
 */
export async function waitForPageWs(port: number, marker: string, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const list = await fetch(`http://127.0.0.1:${port}/json`);
      if (list.ok) {
        const targets = (await list.json()) as { type?: string; url?: unknown; webSocketDebuggerUrl?: string }[];
        const hit =
          targets.find((t) => t.type === 'page' && typeof t.url === 'string' && t.url.includes(marker)) ||
          targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
        if (hit && hit.webSocketDebuggerUrl) return hit.webSocketDebuggerUrl;
      }
    } catch {
      /* 端口尚未就绪，继续轮询 */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('CDP page target 未在端口 ' + port + ' 就绪（marker=' + marker + '）');
}

/** 一条解析后的 CDP 消息（命令响应或域事件；线上数据是动态的，只声明本封装用到的字段）。 */
interface CdpMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { message: string };
}

/** 诊断收集容器（startDiagnostics 后按域事件填充）。 */
/**
 * 诊断收集容器的形状。
 *
 * ## 为什么可选属性要显式写 `| undefined`
 *
 * 根 tsconfig 开了 **`exactOptionalPropertyTypes: true`**：`url?: string` 意味着
 * "这个键可以**不存在**"，但**不允许**传 `{ url: undefined }`。
 *
 * 而这里的记录来自 CDP 事件的**运行时解构**——`const { url, status } = p.response`，
 * 拿到的就是 `string | undefined`；当 `url` 缺失时我们会**真的写进** `url: undefined`。
 * 两者语义不同（"键缺省" vs "键存在且为 undefined"），`| undefined` 才是如实描述。
 *
 * 注意：本文件此前是 `.mjs`（不被 tsc 检查），迁移到 `.ts` 后这些宽松写法第一次过类型检查，
 * 就被这条规则抓了出来。这属于**类型声明补全**，不是行为改动。
 */
interface CdpDiagnostics {
  console: { type: string; text: string }[];
  exceptions: { text: string; url?: string | undefined; line?: number | undefined }[];
  failedRequests: { url?: string | undefined; status?: number | string | undefined }[];
  responses: { url?: string | undefined; status?: number | undefined }[];
}

/**
 * 无第三方依赖 CDP 会话：用 Node 22 内置全局 `WebSocket` 直连 Chrome DevTools Protocol。
 * 仅封装 E1 需要的子集（Page / Runtime / Input）。
 */
export class CdpSession {
  /** 底层 WebSocket（构造函数里建立）。 */
  private _ws: WebSocket;
  /** 下一条命令的自增 id。 */
  private _id: number;
  /** 未完成命令的 resolve/reject（按 id 索引）。 */
  private _pending: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>;
  /** 未 open 前排队的命令帧。 */
  private _queue: string[];
  /** WebSocket 是否已 open（open 前命令入队）。 */
  private _open: boolean;
  /** 诊断收集容器（默认空，startDiagnostics 才开始填充）。 */
  private _diag: CdpDiagnostics;
  /** 诊断域是否已开启。 */
  private _diagOn: boolean;

  /** @param {string} wsUrl page target 的 webSocketDebuggerUrl */
  public constructor(wsUrl: string) {
    const WS = globalThis.WebSocket;
    if (typeof WS !== 'function') throw new Error('Node 缺全局 WebSocket（需 Node >= 22）');
    this._ws = new WS(wsUrl);
    this._id = 0;
    this._pending = new Map();
    this._queue = [];
    this._open = false;
    // 诊断收集（2026-10-06 第六十二轮）：真实场景跑测最需要的三件仪器——控制台错误、未捕获异常、
    // 网络失败/非 2xx。前端缺陷绝大多数先在控制台留痕，而"页面看起来没崩"不等于没问题。
    // 默认关闭（startDiagnostics 才开域），对既有用例零行为变更。
    this._diag = { console: [], exceptions: [], failedRequests: [], responses: [] };
    this._diagOn = false;
    this._ws.addEventListener('open', () => {
      this._open = true;
      for (const m of this._queue) this._ws.send(m);
      this._queue = [];
    });
    this._ws.addEventListener('message', (ev) => this._onMessage(ev.data ?? ev));
    this._ws.addEventListener('error', () => this._failAll(new Error('CDP WebSocket 错误')));
    this._ws.addEventListener('close', () => this._failAll(new Error('CDP WebSocket 已关闭')));
  }

  /**
   * 打开诊断域（Runtime / Log / Network / Page）并开始收集。
   *
   * 为什么必须显式开：CDP 只在域启用后推送事件；不开域就断言"没有控制台错误"是**假绿**。
   * @returns 无返回值。
   */
  public async startDiagnostics() {
    await this.send('Page.enable');
    await this.send('Runtime.enable');
    await this.send('Log.enable');
    await this.send('Network.enable');
    this._diagOn = true;
  }

  /** 清空已收集的诊断（用于"某段操作期间零错误"的精确断言）。 */
  public clearDiagnostics() {
    this._diag = { console: [], exceptions: [], failedRequests: [], responses: [] };
  }

  /** 取诊断快照（深拷贝，调用方不会改到内部状态）。 */
  public diagnostics(): CdpDiagnostics {
    return JSON.parse(JSON.stringify(this._diag));
  }

  /**
   * 收集诊断条目（按域事件）。
   * @param msg 一条 CDP 消息。
   * @returns 无返回值。
   */
  private _collect(msg: CdpMessage) {
    if (!this._diagOn) return;
    // CDP 事件参数线上是动态的，按域分支收窄到各自的真实形状（只声明用到的字段）。
    const p = msg.params ?? {};
    if (msg.method === 'Runtime.consoleAPICalled') {
      const cp = p as { args?: { value?: unknown; description?: string; type?: string }[]; type: string };
      const text = (cp.args ?? [])
        .map((a) => (a.value !== undefined ? String(a.value) : (a.description ?? a.type)))
        .join(' ');
      this._diag.console.push({ type: cp.type, text: text.slice(0, 500) });
    } else if (msg.method === 'Runtime.exceptionThrown') {
      const d = (p.exceptionDetails ?? {}) as {
        text?: string;
        url?: string;
        lineNumber?: number;
        exception?: { description?: string };
      };
      this._diag.exceptions.push({
        text: String(d.exception?.description ?? d.text ?? '').slice(0, 500),
        url: d.url,
        line: d.lineNumber,
      });
    } else if (msg.method === 'Log.entryAdded') {
      const e = (p.entry ?? {}) as { level?: string; text?: string };
      if (e.level === 'error' || e.level === 'warning') {
        this._diag.console.push({ type: `log.${e.level}`, text: `${e.text ?? ''}`.slice(0, 500) });
      }
    } else if (msg.method === 'Network.responseReceived') {
      const r = (p.response ?? {}) as { url?: string; status?: number };
      this._diag.responses.push({ url: r.url, status: r.status });
      if (typeof r.status === 'number' && r.status >= 400) {
        this._diag.failedRequests.push({ url: r.url, status: r.status });
      }
    } else if (msg.method === 'Network.loadingFailed') {
      // `net::ERR_ABORTED` 常由页面自身取消（导航/SSE 重连）引起，不算缺陷；其余（404/连接拒绝）算。
      const err = String(p.errorText ?? '');
      if (!/ERR_ABORTED/.test(err)) {
        this._diag.failedRequests.push({ url: String(p.documentURL ?? ''), status: err });
      }
    }
  }

  private _failAll(err: Error) {
    for (const { reject } of this._pending.values()) reject(err);
    this._pending.clear();
  }

  private _onMessage(data: unknown) {
    // WebSocket 帧的数据类型线上是动态的（文本帧是 string，二进制帧可能是 ArrayBuffer / Buffer
    // —— Buffer.from 在运行时都能接受），这里按单参重载收窄到 Uint8Array。
    const text =
      typeof data === 'string' ? data : Buffer.from(data as Uint8Array).toString('utf8');
    const msg = JSON.parse(text) as CdpMessage;
    if (msg.id !== undefined && this._pending.has(msg.id)) {
      // 上一行的 has() 已确认该 id 存在，非空断言只是把这一事实带给类型系统。
      const { resolve, reject } = this._pending.get(msg.id)!;
      this._pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
      return;
    }
    if (msg.method !== undefined) this._collect(msg);
  }

  /** 发送一条 CDP 命令并返回 result（Promise；result 形状由调用方按域收窄）。 */
  public send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = ++this._id;
    const payload = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      if (this._open) this._ws.send(payload);
      else this._queue.push(payload);
    });
  }

  /** 导航到指定 URL（启用 Page 域）。 */
  public async navigate(url: string) {
    await this.send('Page.enable');
    await this.send('Page.navigate', { url });
  }

  /**
   * 在页面上下文执行表达式并返回值（`returnByValue`）。
   *
   * ## 返回类型为什么必须是 `any`
   *
   * 这是**真正的动态边界**：结果形状完全由调用方传入的表达式决定，TS 无从推断——
   * 与 `JSON.parse` 同类。写成 `unknown` 看着更"安全"，但它会强迫**每个**调用点写断言
   * （`pageScrollLock` / `turnDiffCard` 这类直接拿结果当具体类型用的判据首当其冲），
   * 结果是几十处无信息量的 `as`，真实类型风险一点没减少。
   *
   * 所以这里保留 `any`，并用**定向抑制**（而不是全局关掉 `no-explicit-any`）——
   * 全库 `no-explicit-any` 仍是 error，只有这一处被明确豁免，且理由写在注释里。
   *
   * @param expression 在页面上下文求值的 JS 表达式
   * @returns 表达式结果（形状由表达式决定，调用方按需收窄）
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 页面求值结果是真动态边界，见上方注释
  public async evaluate(expression: string): Promise<any> {
    await this.send('Runtime.enable');
    const r = (await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })) as { exceptionDetails?: unknown; result?: { value?: unknown } };
    if (r.exceptionDetails) throw new Error('CDP evaluate 异常: ' + JSON.stringify(r.exceptionDetails));
    return r.result ? r.result.value : undefined;
  }

  /** 轮询谓词（表达式返回真值）直至次数耗尽。 */
  public async waitFor(predicateExpr: string, tries = 400) {
    for (let i = 0; i < tries; i++) {
      const v = await this.evaluate(predicateExpr);
      if (v) return true;
      await new Promise((r) => setTimeout(r, 0));
    }
    return false;
  }

  /** 等待 app 挂载（composer textarea + send 按钮均在 DOM 中）。 */
  public async waitMounted(tries = 800) {
    return this.waitFor(
      "!!document.querySelector('.composer-input textarea') && !!document.querySelector('button.send')",
      tries,
    );
  }

  /**
   * 截图保存为 PNG，返回字节数。
   *
   * `captureBeyondViewport: false` 是**有意**的（2026-10-07 实测）：默认值会让 Chrome 在多帧合成
   * 路径上截"超出视口"的画面，此时 `backdrop-filter` 的模糊层会呈现为"顶部一条未模糊的带"——
   * 而我们用同一页做了三组对照（无浮层基线 / 有浮层后的逐行亮度 / backdrop 与 app 的 rect 完全相同）
   * 证明**真实视口里模糊是满覆盖的**，那条带纯属捕获伪影。截图是给人眼复核用的，必须与真人看到的一致。
   * @param path 目标文件路径
   * @returns 写入字节数
   */
  public async screenshot(path: string) {
    // 线上返回动态：成功时必有 data（base64 PNG），按此形状收窄。
    const r = (await this.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
    })) as { data: string };
    const buf = Buffer.from(r.data, 'base64');
    writeFileSync(path, buf);
    return buf.length;
  }

  private async _center(selector: string): Promise<{ x: number; y: number } | null> {
    // 页面侧表达式按 returnByValue 序列化，形状由上方注入脚本决定。
    return (await this.evaluate(
      `(function(){ var el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; var b = el.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`,
    )) as { x: number; y: number } | null;
  }

  /** 真实鼠标点击（CDP Input，证明操作回环可达 app）。Input 域在新版 Chrome 默认开启，无需 Input.enable。 */
  public async click(selector: string) {
    // 先把目标滚进视口再量坐标（2026-10-08 实测的真陷阱）：CDP 点击用的是**真实鼠标坐标**，
    // 元素在视口外时 `getBoundingClientRect()` 给出的 y 落在窗口之外 ⇒ 事件打在空白处，
    // 表现是「点了没反应」——探针会把它误报成「功能没接线」。编排面板底部的续跑按钮就是这样被漏掉的。
    await this.evaluate(
      `(function(){ var el = document.querySelector(${JSON.stringify(selector)}); if (el && el.scrollIntoView) el.scrollIntoView({ block: 'center', inline: 'nearest' }); return !!el; })()`,
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    const c = await this._center(selector);
    if (!c) throw new Error('CDP 点击目标未找到: ' + selector);
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: c.x, y: c.y, button: 'left', clickCount: 1 });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: c.x, y: c.y, button: 'left', clickCount: 1 });
  }

  /**
   * 把真实鼠标移到元素中心（**悬停**，不按下）。
   *
   * 存在的理由：悬浮提示只在真实指针通路下出现（`mouseover` 由 Chrome 的 Input 域
   * 在 move 时合成），`evaluate` 里 dispatch 一个合成事件测不到"指针真的到了那里"。
   * @param selector 目标选择器
   * @returns 无
   */
  public async hover(selector: string) {
    await this.evaluate(
      `(function(){ var el = document.querySelector(${JSON.stringify(selector)}); if (el && el.scrollIntoView) el.scrollIntoView({ block: 'center', inline: 'nearest' }); return !!el; })()`,
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    const c = await this._center(selector);
    if (!c) throw new Error('CDP 悬停目标未找到: ' + selector);
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: c.x, y: c.y });
  }

  /** 把鼠标移到视口左上角空白处（离开所有带提示的元素）。 @returns 无 */
  public async hoverAway() {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2 });
  }

  /** 聚焦并逐字符键入（真实键盘事件，computer use 风格）。 */
  public async type(selector: string, text: string) {
    await this.click(selector);
    for (const ch of text) {
      await this.send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch });
      await this.send('Input.dispatchKeyEvent', { type: 'keyUp', text: ch });
    }
  }

  /** 通过假后端钩子推送一条 SSE 事件（驱动流式 / 工具结果）。 */
  public async push(env: unknown) {
    await this.evaluate('window.__PUSH__(' + JSON.stringify(env) + ')');
  }

  /**
   * 真实按键（含组合键）：走 CDP Input，与 `type()` 同一条真实输入通路。
   *
   * 存在理由：快捷键（如 Ctrl+K 命令面板）用 `type()` 送不出——它只发 `text` 字符事件，
   * 不带修饰键与虚拟键码，页面上的组合键监听收不到。
   * @param key 键名（CDP 口径：'k' / 'Escape' / 'Enter' …）。
   * @param options 可选 `{ modifiers, code, keyCode }`；modifiers 为位掩码（Ctrl=2、Shift=8、Alt=1、Meta=4）。
   * @returns 无返回值。
   */
  public async press(key: string, options: { modifiers?: number; keyCode?: number; code?: string } = {}) {
    const modifiers = options.modifiers ?? 0;
    const upper = key.length === 1 ? key.toUpperCase() : key;
    const keyCode = options.keyCode ?? (key.length === 1 ? upper.charCodeAt(0) : 0);
    const base = {
      key: upper,
      code: options.code ?? (key.length === 1 ? `Key${upper}` : key),
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode,
      modifiers,
    };
    await this.send('Input.dispatchKeyEvent', {
      type: modifiers === 0 ? 'keyDown' : 'rawKeyDown',
      ...base,
      ...(modifiers === 0 && key.length === 1 ? { text: key } : {}),
    });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  }

  /** 关闭底层 WebSocket。 */
  public close() {
    try {
      this._ws.close();
    } catch {
      /* 已关闭 */
    }
  }
}

/** 默认站点根（供测试引用）。 */
export const WEB_ROOT_PATH = WEB_ROOT;

/** 供 skip 用的最小测试上下文（vitest 的 test 上下文结构兼容：本函数只用到 skip）。 */
interface SkipCapableTestContext {
  skip: (reason?: string) => void;
}

/** openStubSession 的可选配置。 */
interface StubSessionOptions {
  /** 入口路径名（挂到 `/_xxx.html`）。 */
  stub?: string;
  /** 自定义页面 HTML（如带 `__RPC_OVERRIDES__` 的桩）；缺省用 stubHtmlCdp()。 */
  html?: string;
  /** 视口宽。 */
  width?: number;
  /** 视口高。 */
  height?: number;
  /** 挂载判据选择器。 */
  waitFor?: string;
  /** 附加到导航 URL 的 hash。 */
  hash?: string;
}

/**
 * 起一次「真 Chrome + stub 页（真前端 + 假后端）」会话（CDP 用例共用入口）。
 *
 * 收尾对称：无论成败都关掉浏览器整树、静态服务与临时 profile；环境不可用（本机无 Chrome/Edge，
 * 或 Node 无全局 WebSocket）时**显式 skip** 并返回 null —— 绝不伪装通过。
 * @param {SkipCapableTestContext} t vitest 测试上下文（不可用时用于 skip）
 * @param {StubSessionOptions} [options]
 *   入口路径名 / 自定义页面（如带 `__RPC_OVERRIDES__` 的桩） / 视口尺寸 / 挂载判据选择器
 * @returns {Promise<{cdp: CdpSession, close: () => Promise<void>} | null>} 会话；不可用返回 null
 */
export async function openStubSession(
  t: SkipCapableTestContext,
  options: StubSessionOptions = {},
): Promise<{ cdp: CdpSession; close: () => Promise<void> } | null> {
  const browser = findBrowser();
  if (browser === null) {
    if (requireBrowser()) {
      throw new Error('OMNI_REQUIRE_BROWSER=1 要求必须跑，但未找到本机 Chrome/Edge');
    }
    t.skip('未找到本机 Chrome/Edge；设 OMNI_CHROME_PATH 后重跑');
    return null;
  }
  if (typeof globalThis.WebSocket !== 'function') {
    if (requireBrowser()) {
      throw new Error('OMNI_REQUIRE_BROWSER=1 要求必须跑，但 Node 缺全局 WebSocket');
    }
    t.skip('Node 缺全局 WebSocket（需 Node ≥22）');
    return null;
  }
  const stub = options.stub ?? '_cdp-stub.html';
  const html = options.html ?? stubHtmlCdp();
  const width = options.width ?? 1000;
  const height = options.height ?? 700;
  const waitFor = options.waitFor ?? '.composer-input textarea';
  const hash = options.hash ?? '';
  const server = await serveStatic(WEB_ROOT, { [`/${stub}`]: html });
  const userDataDir = makeOmniTemp('omni-cdp-');
  const cdpPort = await getFreePort();
  const proc = launchChromeForCdp(browser, `http://127.0.0.1:${server.port}/${stub}`, userDataDir, cdpPort);
  /** 收干净：浏览器整树 + 静态服务 + 临时 profile。 @returns {Promise<void>} 无 */
  const cleanup = async () => {
    killChromeTree(proc, userDataDir);
    await server.close();
    // 带锁重试强删（omniTemp）：锁释放滞后时单次 rmSync 静默失败（Temp 19 GB 成因之一）；
    // 仍失败的交给 omniTemp/生产 TmpSweep 按前缀兜底。
    rmRfRetry(userDataDir);
  };
  let cdp: CdpSession | undefined;
  try {
    cdp = new CdpSession(await waitForPageWs(cdpPort, stub));
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await cdp.navigate(`http://127.0.0.1:${server.port}/${stub}${hash}`);
    await cdp.waitFor(`!!document.querySelector('${waitFor}')`, 2000);
  } catch (err) {
    if (cdp !== undefined) cdp.close();
    await cleanup();
    throw err;
  }
  return {
    cdp,
    async close() {
      cdp.close();
      await cleanup();
    },
  };
}
