// 共享浏览器验证工具（E1 CDP 路线；**零依赖**，不引入 playwright / puppeteer / ws / CDP 库）。
//
// 与 D3 的 --dump-dom 路线（web/test/e2e.test.mjs）同源：复用本机已装 Chrome/Edge，
// 用零依赖 Node http 静态服务托管 web/，并注入假 /rpc + 假 /events 使前端在确定性假后端下渲染。
// 本文件在其上新增 **CDP 路线**：用 Node 22 内置全局 `WebSocket` 直连 Chrome DevTools Protocol，
// 做「截图 → 视觉核对 → 操作回环」一例（E1 的可证伪验收）。
//
// 无浏览器时调用方应显式 skip（不伪装通过）；可用 OMNI_CHROME_PATH 指定可执行文件。

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createNetServer } from 'node:net';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(HERE, '..');
const INDEX_HTML = join(WEB_ROOT, 'index.html');

/** 候选浏览器可执行文件（env 覆盖优先；Windows / macOS / Linux 三平台）。 */
const BROWSER_CANDIDATES = [
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
export function findBrowser() {
  for (const candidate of BROWSER_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** 静态资源 MIME 表（模块加载对 MIME 敏感，缺失会导致 app 静默不启动）。 */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.map': 'application/json; charset=utf-8',
};

/**
 * 零依赖静态服务（127.0.0.1 随机端口），托管 web/ 目录，并把内存路由注入。
 * @param {string} root 站点根目录
 * @param {Record<string, string>} memoryRoutes 内存路由（路径 → HTML 文本）
 * @returns {Promise<{port:number, close:()=>Promise<void>}>} 端口与关闭器
 */
export function serveStatic(root, memoryRoutes) {
  const server = createServer((req, res) => {
    const rawPath = decodeURIComponent((req.url || '/').split('?')[0]);
    const html = memoryRoutes[rawPath];
    if (html !== undefined) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
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
  return new Promise((res) => {
    server.listen(0, '127.0.0.1', () => {
      res({
        port: server.address().port,
        close: () => new Promise((done) => server.close(() => done())),
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
    "    'model.catalog': { providers: [], active: { id:'mock', label:'Mock 厂商', defaultModel:'mock-e2e', model:'mock-e2e', models:['mock-e2e'], reasoningEffort:['low','high'] } },",
    "    'config.get': { modelAdapter:'mock', model:'mock-e2e', reasoning:'medium', approval:'ask' },",
    "    'sessions.list': { dir:'', sessions: [] },",
    "    'workspace.list': { current:'', workspaces: [] },",
    "    'fs.list': { tree: [] },",
    "    'approval.tiers': { tiers: [] },",
    "    'changes.list': { files: [] },",
    "    'usage.stats': { source:'live', dir:'', byModel:{}, total:{calls:0,prompt:0,completion:0,total:0}, sessions:[] },",
    "    'context.usage': { categories:[] },",
    "    'approval.respond': { ok:true },",
    "    'turns.run': { pending:true }",
    '  };',
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
    "      .then(function(sent){ ok('approval responded', sent); push({ method:'thread.event', params:{ event:{ id:'e1', type:'tool_call', timestamp:1, payload:{ callId:'c1', name:'write_file', args:{ path:'src/demo.ts', content:'export const x = 1;' } } } } }); push({ method:'thread.event', params:{ event:{ id:'e2', type:'tool_result', timestamp:2, payload:{ callId:'c1', ok:true, text:'已写入 src/demo.ts' } } } }); return until(function(){ return !!q('.artifact-card .artifact-name'); }, 400); })",
    "      .then(function(shown){ ok('artifact card visible', shown); var n = q('.artifact-card .artifact-name'); ok('artifact name', n && n.textContent === 'demo.ts'); var href = q('.artifact-card .artifact-download'); ok('artifact download link', href && href.getAttribute('href') === '/files?path=src%2Fdemo.ts'); if (window.__RESOLVE_TURN__) window.__RESOLVE_TURN__({ threadId:'t-e2e', finalText:'', steps:1 }); push({ method:'thread.event', params:{ event:{ id:'e3', type:'assistant', timestamp:3, payload:{ content:'正在分析…' } } } }); return until(function(){ return !!q('.ev.assistant .card.assistant .content'); }, 400); })",
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
  const index = readFileSync(INDEX_HTML, 'utf8');
  const injected = '<script>\n' + injectedBody() + '\n</script>';
  return index.replace('<div id="root"></div>', '<div id="root"></div>\n' + injected);
}

/** 取一个空闲本地端口（供 Chrome `--remote-debugging-port` 使用）。 @returns {Promise<number>} */
export function getFreePort() {
  return new Promise((res, rej) => {
    const s = createNetServer();
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port;
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
export function launchChromeForCdp(browser, url, userDataDir, port) {
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
 * 轮询 Chrome `/json`，取与本页匹配的 page target 的 WebSocket 调试地址。
 * @param {number} port 远程调试端口
 * @param {string} marker 启动 URL 路径标记（用于匹配 page target）
 * @param {number} [timeoutMs] 超时
 * @returns {Promise<string>} page target 的 webSocketDebuggerUrl
 */
export async function waitForPageWs(port, marker, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const list = await fetch(`http://127.0.0.1:${port}/json`);
      if (list.ok) {
        const targets = await list.json();
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

/**
 * 零依赖 CDP 会话：用 Node 22 内置全局 `WebSocket` 直连 Chrome DevTools Protocol。
 * 仅封装 E1 需要的子集（Page / Runtime / Input）。
 */
export class CdpSession {
  /** @param {string} wsUrl page target 的 webSocketDebuggerUrl */
  constructor(wsUrl) {
    const WS = globalThis.WebSocket;
    if (typeof WS !== 'function') throw new Error('Node 缺全局 WebSocket（需 Node >= 22）');
    this._ws = new WS(wsUrl);
    this._id = 0;
    this._pending = new Map();
    this._queue = [];
    this._open = false;
    this._ws.addEventListener('open', () => {
      this._open = true;
      for (const m of this._queue) this._ws.send(m);
      this._queue = [];
    });
    this._ws.addEventListener('message', (ev) => this._onMessage(ev.data ?? ev));
    this._ws.addEventListener('error', () => this._failAll(new Error('CDP WebSocket 错误')));
    this._ws.addEventListener('close', () => this._failAll(new Error('CDP WebSocket 已关闭')));
  }

  _failAll(err) {
    for (const { reject } of this._pending.values()) reject(err);
    this._pending.clear();
  }

  _onMessage(data) {
    const text = typeof data === 'string' ? data : Buffer.from(data).toString('utf8');
    const msg = JSON.parse(text);
    if (msg.id !== undefined && this._pending.has(msg.id)) {
      const { resolve, reject } = this._pending.get(msg.id);
      this._pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    }
  }

  /** 发送一条 CDP 命令并返回 result（Promise）。 */
  send(method, params = {}) {
    const id = ++this._id;
    const payload = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      if (this._open) this._ws.send(payload);
      else this._queue.push(payload);
    });
  }

  /** 导航到指定 URL（启用 Page 域）。 */
  async navigate(url) {
    await this.send('Page.enable');
    await this.send('Page.navigate', { url });
  }

  /** 在页面上下文执行表达式并返回值（returnByValue）。 */
  async evaluate(expression) {
    await this.send('Runtime.enable');
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('CDP evaluate 异常: ' + JSON.stringify(r.exceptionDetails));
    return r.result ? r.result.value : undefined;
  }

  /** 轮询谓词（表达式返回真值）直至次数耗尽。 */
  async waitFor(predicateExpr, tries = 400) {
    for (let i = 0; i < tries; i++) {
      const v = await this.evaluate(predicateExpr);
      if (v) return true;
      await new Promise((r) => setTimeout(r, 0));
    }
    return false;
  }

  /** 等待 app 挂载（composer textarea + send 按钮均在 DOM 中）。 */
  async waitMounted(tries = 800) {
    return this.waitFor(
      "!!document.querySelector('.composer-input textarea') && !!document.querySelector('button.send')",
      tries,
    );
  }

  /** 截图保存为 PNG，返回字节数。 */
  async screenshot(path) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    const buf = Buffer.from(r.data, 'base64');
    writeFileSync(path, buf);
    return buf.length;
  }

  async _center(selector) {
    return this.evaluate(
      `(function(){ var el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; var b = el.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`,
    );
  }

  /** 真实鼠标点击（CDP Input，证明操作回环可达 app）。Input 域在新版 Chrome 默认开启，无需 Input.enable。 */
  async click(selector) {
    const c = await this._center(selector);
    if (!c) throw new Error('CDP 点击目标未找到: ' + selector);
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: c.x, y: c.y, button: 'left', clickCount: 1 });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: c.x, y: c.y, button: 'left', clickCount: 1 });
  }

  /** 聚焦并逐字符键入（真实键盘事件，computer use 风格）。 */
  async type(selector, text) {
    await this.click(selector);
    for (const ch of text) {
      await this.send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch });
      await this.send('Input.dispatchKeyEvent', { type: 'keyUp', text: ch });
    }
  }

  /** 通过假后端钩子推送一条 SSE 事件（驱动流式 / 工具结果）。 */
  async push(env) {
    await this.evaluate('window.__PUSH__(' + JSON.stringify(env) + ')');
  }

  /** 关闭底层 WebSocket。 */
  close() {
    try {
      this._ws.close();
    } catch {
      /* 已关闭 */
    }
  }
}

/** 默认站点根（供测试引用）。 */
export const WEB_ROOT_PATH = WEB_ROOT;
