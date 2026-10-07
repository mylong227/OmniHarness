// D3：UI e2e 冒烟（无第三方依赖路线，**不引入 playwright**）。
//
// 依赖准入约束：playwright / puppeteer 体积与传递依赖远超本项目依赖预算（默认 2MB / 20 个传递依赖），
// 且 E1 已确立「CDP 驱动本机已装浏览器」的运行时无第三方依赖路线。故此处直接复用本机 Chrome/Edge：
//   1. 无第三方依赖 Node http 静态服务托管 web/（.js 必须回 text/javascript 才能被模块加载）；
//   2. 生成 stub 页：在 app 的 ESM 之前注入 fake fetch(/rpc) 与 fake EventSource(/events)，
//      使前端在**确定性假后端**下渲染，无需真实模型 / API key；
//   3. headless Chrome 以 `--remote-debugging-port` 起（CDP 路线），用例直连 DevTools Protocol
//      读回 stub 场景写进 `#e2e-result` 的最终结果载荷并断言。
//
//      **2026-09-27 换掉 `--dump-dom`（原 D3 路线）**：该路线在本机 Chrome 154.0.8037.58 / Windows 上
//      表现为「进程 exit 0、stdout 0 字节、stderr 0 字节、耗时 <0.5s」，用例报「未能在 DOM 中找到
//      e2e 结果标记」——而**同一台机器同一个二进制**在 CDP 路线下渲染/截图/求值全部正常
//      （`web/test/e2e-cdp.test.mjs` 2.1s 通过、截图 48KB）。逐条实测：`--dump-dom` 走管道 stdout 为空、
//      shell 重定向到文件仍为 0 字节、`--print-to-pdf` 也不产出文件——即失效的是这组**一次性 headless
//      CLI 输出**，不是 headless 本身，也不是被测前端。继续守着它只会把「传输方式失效」长期伪装成
//      「产品回归」（board §22.9 曾据此把它定性为环境问题并搁置）。
//      换 CDP 后：不依赖任何一次性 CLI 输出、与仓内既有浏览器用例（e2e-cdp / responsiveProbe /
//      virtualProbe / liveUiE2e）同一传输，且同样零第三方依赖（Node 22 内置 WebSocket）。
//      注意：stub 场景的 `until()` 轮询本就是**按次数**收敛（见下方 scenario 定义），与是否启用
//      `--virtual-time-budget` 无关，故去掉虚拟时间后行为不变。
//
// 覆盖关键路径一条：**发任务 → 审批 → 流式 → 产物 → 回合收敛**。
// 未找到浏览器时**显式 skip**（不伪装成通过）；可用 OMNI_CHROME_PATH 指定可执行文件。
// 调试开关：OMNI_E2E_VERBOSE=1 打印浏览器 stderr 与诊断；OMNI_E2E_TIMEOUT_MS 覆盖单次浏览器超时。
//
// 两处易踩的坑（都曾让本用例长期红着，2026-09-19 定位）：
//   ① 「流式文本合入」断言的是 `textContent` 严格相等。渲染走 markdown 管线时，markdown-it 的
//      块级渲染器**恒定在末尾补一个 \n**；该 \n 在 DOM 里是一个真实文本节点，会进 textContent。
//      这不是「测试期望错」也不是「渲染器错」，而是**产出未归一**——正解是在 markdownRender
//      处剥掉这个块终止符（同时 .md-content 曾从 .content 继承 `white-space:pre-wrap`，
//      把块间换行渲染成实打实的空行 ⇒ 一并修掉），**不是**把断言放宽成 trim（那会连同真实
//      的空白缺陷一起放过）。
//   ② 收敛判定必须**轮询到稳定态**再取样。`busy` 由 ComposerController 在 turns.run resolve
//      之后才置回 false，而 assistant 事件是同一轮里更早到达的 ⇒ 「最终卡片出现」≠「回合已收敛」。
//      早先直接在最后取样，会拿到「还在生成中」的中间态（停止按钮仍在），是**取样过早**而非缺陷。
//      这里改为 until() 轮询「发送键回来且停止键消失」，把「回合收敛」本身变成一条显式断言。

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  findBrowser,
  serveStatic,
  getFreePort,
  launchChromeForCdp,
  killChromeTree,
  waitForPageWs,
  CdpSession,
} from './browserHarness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(HERE, '..');
const INDEX_HTML = join(WEB_ROOT, 'index.html');
const STUB_NAME = '_e2e-stub.html';

/**
 * 生成 stub 页：在 app ESM 之前注入假 /rpc 与假 /events，并跑确定性场景把结果写进 #e2e-result。
 * 注入代码刻意只用单引号与字符串拼接（整段作为模板字面量内嵌，避免反引号/`${` 冲突）。
 * @returns {string} 完整 HTML 文本
 */
function stubHtml() {
  const index = readFileSync(INDEX_HTML, 'utf8');
  const injected = [
    '<script>',
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
    // 自诊断：把页面内的脚本错误 / console.error / RPC 清单一起带回，避免「只看到 app 未挂载」而无线索。
    '  var DIAG = { errors: [], stacks: [], console: [] };',
    '  window.addEventListener("error", function(e){ DIAG.errors.push(String((e && e.message) || e)); if (e && e.error && e.error.stack) DIAG.stacks.push(String(e.error.stack)); });',
    '  window.addEventListener("unhandledrejection", function(e){ DIAG.errors.push("rejection: " + String((e && e.reason && e.reason.message) || (e && e.reason))); if (e && e.reason && e.reason.stack) DIAG.stacks.push(String(e.reason.stack)); });',
    '  var _consoleError = console.error;',
    '  console.error = function(){ DIAG.console.push(Array.prototype.join.call(arguments, " ")); return _consoleError.apply(console, arguments); };',
    '  var sleep = function(ms){ return new Promise(function(r){ setTimeout(r, ms); }); };',
    // 轮询必须按**次数**收敛，不能按墙钟时间：`--virtual-time-budget` 会加速页面内的 Date.now()，
    // 用 `Date.now() - t0 > ms` 判定会让循环在第一次检查时就「超时」提前退出（实测 steps 只剩两条）。
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
    "      .then(function(shown){ ok('streaming card visible', shown); var c = q('.streaming-assistant .content'); DIAG.streamText = c ? c.textContent : null; DIAG.streamHtml = c ? c.innerHTML : null; return until(function(){ var el = q('.streaming-assistant .content'); return !!el && el.textContent === '正在分析…'; }, 1200).then(function(merged){ var el2 = q('.streaming-assistant .content'); DIAG.streamText = el2 ? el2.textContent : null; DIAG.streamHtml = el2 ? el2.innerHTML : null; ok('streaming text merged', merged); push({ method:'approval.request', params:{ requestId:'r1', toolName:'shell', target:'rm -rf /tmp/x' } }); return until(function(){ return !!q('.overlay.show .modal[role=\"dialog\"]'); }, 400); }); })",
    "      .then(function(shown){ ok('approval modal visible', shown); var allow = q('.overlay.show .modal .allow'); ok('approval allow button', !!allow); if (allow) allow.click(); return until(function(){ return RPC_CALLS.some(function(c){ return c.method === 'approval.respond'; }); }, 400); })",
    "      .then(function(sent){ ok('approval responded', sent); push({ method:'thread.event', params:{ event:{ id:'e1', type:'tool_call', timestamp:1, payload:{ callId:'c1', name:'write_file', args:{ path:'src/demo.ts', content:'export const x = 1;' } } } } }); push({ method:'thread.event', params:{ event:{ id:'e2', type:'tool_result', timestamp:2, payload:{ callId:'c1', ok:true, text:'已写入 src/demo.ts' } } } }); return until(function(){ return !!q('.artifact-card .artifact-name'); }, 400); })",
    "      .then(function(shown){ ok('artifact card visible', shown); var n = q('.artifact-card .artifact-name'); ok('artifact name', n && n.textContent === 'demo.ts'); var href = q('.artifact-card .artifact-download'); ok('artifact download link', href && href.getAttribute('href') === '/files?path=src%2Fdemo.ts'); if (window.__RESOLVE_TURN__) window.__RESOLVE_TURN__({ threadId:'t-e2e', finalText:'', steps:1 }); push({ method:'thread.event', params:{ event:{ id:'e3', type:'assistant', timestamp:3, payload:{ content:'正在分析…' } } } }); return until(function(){ return !!q('.ev.assistant .card.assistant .content'); }, 400); })",
    "      .then(function(shown){ ok('final assistant card', shown); return until(function(){ return !!q('.composer button.send') && !q('.composer button.stop'); }, 600); })",
    "      .then(function(idle){ ok('composer idle after turn', idle); });",
    '  };',
    '  var finish = function(){',
    "    var root = document.getElementById('root');",
    '    var payload = {',
    '      steps: steps,',
    '      diag: {',
    '        errors: DIAG.errors,',
    '        stacks: DIAG.stacks.slice(0, 3),',
    '        consoleErrors: DIAG.console.slice(0, 10),',
    '        rpc: RPC_CALLS.map(function(c){ return c.method; }),',
    '        rootHtmlLen: root ? root.innerHTML.length : -1,',
    '        hasReact: typeof window.React,',
    '        streamText: DIAG.streamText === undefined ? null : DIAG.streamText,',
    '        streamHtml: DIAG.streamHtml === undefined ? null : DIAG.streamHtml,',
    '        selectorHits: {',
    "          composerTextarea: document.querySelectorAll('.composer-input textarea').length,",
    "          sendButton: document.querySelectorAll('button.send').length",
    '        },',
    '      }',
    '    };',
    "    var r = document.createElement('pre'); r.id = 'e2e-result';",
    "    r.textContent = 'E2E_RESULT:' + btoa(unescape(encodeURIComponent(JSON.stringify(payload))));",
    '    document.body.appendChild(r);',
    '  };',
    '  scenario()',
    "    .catch(function(e){ ok('scenario threw: ' + e.message, false); })",
    '    .then(finish, finish);',
    '})();',
    '</script>',
  ].join('\n');
  return index.replace('<div id="root"></div>', '<div id="root"></div>\n' + injected);
}

/**
 * 起 headless 浏览器跑 stub 场景，并经 CDP 取回 `#e2e-result` 的结果载荷。
 *
 * 为什么是 CDP 而不是 `--dump-dom`：见文件头「2026-09-27 换掉 --dump-dom」。要点是该路线在本机
 * Chrome 154 / Windows 上「exit 0 + 零输出」，而 headless 本身完全正常（CDP 路线可渲染/截图/求值）。
 *
 * 超时口径：stub 场景自己把结果写进 `#e2e-result`（失败分支也会写：`scenario().catch(...).then(finish)`），
 * 故这里按**墙钟**轮询该元素出现，超时才算「浏览器/页面没起来」。`OMNI_E2E_TIMEOUT_MS` 覆盖超时。
 *
 * @param {string} browser 浏览器可执行文件
 * @param {string} url 页面地址
 * @param {string} userDataDir 独立用户数据目录
 * @returns {Promise<{dom:string, stderr:string, status:number|null}>} 结果载荷文本与诊断信息
 */
async function dumpDom(browser, url, userDataDir) {
  const timeoutMs = Number(process.env.OMNI_E2E_TIMEOUT_MS || 60_000);
  const port = await getFreePort();
  const child = launchChromeForCdp(browser, url, userDataDir, port);
  let stderr = '';
  child.stderr?.on('data', (chunk) => {
    stderr += chunk;
  });
  let cdp;
  try {
    const wsUrl = await waitForPageWs(port, STUB_NAME, timeoutMs);
    cdp = new CdpSession(wsUrl);
    const deadline = Date.now() + timeoutMs;
    let dom = '';
    while (Date.now() < deadline) {
      const text = String(
        (await cdp.evaluate(
          "(document.getElementById('e2e-result') || {}).textContent || ''",
        )) ?? '',
      );
      if (text.includes('E2E_RESULT:')) {
        dom = text;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    return { dom, stderr, status: dom === '' ? null : 0 };
  } catch (err) {
    stderr += String(err && err.message);
    return { dom: '', stderr, status: null };
  } finally {
    if (cdp !== undefined) cdp.close();
    // 整树终止（Windows 上只 kill 启动器会留下一整棵 Chrome 子进程树，实测一次 10 个）。
    killChromeTree(child, userDataDir);
  }
}

/**
 * 从结果载荷文本里解出场景结果与自诊断信息。
 * @param {string} dom `#e2e-result` 元素的 textContent（形如 `E2E_RESULT:<base64>`）
 * @returns {{steps:Array<{name:string, ok:boolean}>, diag:Record<string, unknown>}} 结果载荷
 */
function parseResult(dom) {
  const m = /E2E_RESULT:([A-Za-z0-9+/=]+)/.exec(dom);
  if (m === null) {
    assert.ok(
      m,
      '未能在页面里找到 e2e 结果标记（场景可能在写结果前就崩了；用 OMNI_E2E_VERBOSE=1 看浏览器 stderr）',
    );
  }
  const json = Buffer.from(m[1], 'base64').toString('utf8');
  const payload = JSON.parse(json);
  return { steps: payload.steps, diag: payload.diag || {} };
}

test('UI e2e：发任务 → 审批 → 流式 → 产物（headless 浏览器 + 假后端）', async (t) => {
  const browser = findBrowser();
  if (!browser) {
    t.skip('未找到本机 Chrome/Edge；设 OMNI_CHROME_PATH 指定浏览器可执行文件后重跑');
    return;
  }

  const server = await serveStatic(WEB_ROOT, { [`/${STUB_NAME}`]: stubHtml() });
  const userDataDir = mkdtempSync(join(tmpdir(), 'omni-e2e-ud-'));
  try {
    const { dom, stderr, status } = await dumpDom(browser, `http://127.0.0.1:${server.port}/${STUB_NAME}`, userDataDir);
    if (process.env.OMNI_E2E_VERBOSE === '1') {
      console.error(`[e2e] browser=${browser} status=${status} domLen=${dom.length}`);
      console.error(`[e2e] stderr tail:\n${stderr.slice(-1500)}`);
    }
    const { steps, diag } = parseResult(dom);
    const failed = steps.filter((s) => !s.ok).map((s) => s.name);
    assert.deepStrictEqual(failed, [], `以下 e2e 步骤失败：${failed.join(' / ')}\n诊断：${JSON.stringify(diag)}`);
    // 关键路径四段必须都在（防止场景被提前短路后「零步骤也算绿」）。
    const names = steps.map((s) => s.name);
    for (const required of [
      'app mounted',
      'turn dispatched',
      'sse connected',
      'streaming card visible',
      'approval modal visible',
      'approval responded',
      'artifact card visible',
      'final assistant card',
      'composer idle after turn',
    ]) {
      assert.ok(names.includes(required), `缺少关键步骤：${required}`);
    }
  } finally {
    await server.close();
    // Chrome 关闭后仍会短暂持有 profile 目录句柄（Windows 上实测 `EBUSY: Account Web Data`），
    // 直接 rmSync 会让**用例本身**因清理失败而变红——那是清理竞态，不是被测行为。
    // 故：带间隔重试 + 末次仍失败只告警（临时目录在该情况下留给 OS 清理）。
    await removeProfileDirBestEffort(userDataDir);
  }
});

/**
 * 尽力删除 Chrome 临时 profile 目录：带间隔重试，末次失败只告警不抛。
 * @param dir profile 目录（mkdtempSync 产物）
 * @returns 无返回值（清理结果不影响用例判定）
 */
async function removeProfileDirBestEffort(dir) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 9) {
        console.warn(
          `[e2e] 临时 profile 目录清理失败（${String(error?.code ?? error)}），留给 OS 清理：${dir}`,
        );
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}
