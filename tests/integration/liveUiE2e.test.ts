/**
 * 真后端 + 真 SPA + 真 Chrome 的端到端体检（集成测试）。
 *
 * ## 为什么需要它（与 `web/test/e2e*.test.mjs` 的分工）
 *
 * `web/test/e2e.test.mjs` / `e2e-cdp.test.mjs` 用**stub 页 + 假后端**验证前端自身（快、稳定、可在 CI 跑）；
 * 本文件起**真实 `omniharness serve`**、用**真 Chrome** 打开**真实构建产物**，跑一条完整回路：
 * `SPA → POST /rpc turns.run → Agent → SSE thread.event → UI 渲染`，并把 HTTP 面（`/healthz`、`/`、
 * `/metrics`、`/rpc`）一并钉住。两者互补：前者防前端回归，后者防「拼起来不工作」。
 *
 * ## 隔离与零副作用（两个刻意的选择）
 *
 * 1. **cwd = 临时工作区**：`serve` 以 cwd 为 workspaceRoot 并向上找 `omniharness.json`。若在仓库根起，
 *    仓库自己的配置（openai + providerKeys）会**覆盖** `--model-adapter mock` ⇒ 变成真实模型回合
 *    （实测：真跑出 12 步、在仓库里写了 `src/hello.ts` 与单测）。隔离后零额度、零副作用、可复现。
 * 2. **storage 目录也指向临时目录**：不污染 `~/.omniharness/sessions`。
 *
 * ## 生物级前提与跳过语义
 *
 * 需要本机 Chrome/Edge（`OMNI_CHROME_PATH` 可指定）与 Node ≥22 的全局 WebSocket；缺任一则
 * **显式 skip**（打印原因），绝不伪装通过。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { UiBaseline } from './uiBaseline.js';

/** 浏览器测试脚手架（源码级 `.mjs`，不被 tsc 编译，故按项目根定位动态 import）。 */
const HARNESS_URL = pathToFileURL(resolve(process.cwd(), 'web/test/browserHarness.mjs')).href;

/** 脚手架里本文件用到的成员（避免为 .mjs 造类型声明文件）。 */
interface BrowserHarness {
  /** 找本机浏览器可执行文件；找不到返回 null。 */
  readonly findBrowser: () => string | null;
  /** 取一个空闲端口。 */
  readonly getFreePort: () => Promise<number>;
  /** 以 `--remote-debugging-port` 起 headless 浏览器。 */
  readonly launchChromeForCdp: (
    browser: string,
    url: string,
    userDataDir: string,
    port: number,
  ) => ChildProcess;
  /** 等页面 target 的 CDP WebSocket 出现。 */
  readonly waitForPageWs: (port: number, marker: string, timeoutMs?: number) => Promise<string>;
  /** CDP 会话。 */
  readonly CdpSession: new (wsUrl: string) => CdpSessionLike;
}

/** CDP 会话（本文件用到的子集）。 */
interface CdpSessionLike {
  /** 等 app 挂载。 */
  readonly waitMounted: () => Promise<boolean>;
  /** 截图写盘，返回字节数。 */
  readonly screenshot: (path: string) => Promise<number>;
  /** 求值 JS 表达式。 */
  readonly evaluate: (expression: string) => Promise<unknown>;
  /** 往选择器输入文本。 */
  readonly type: (selector: string, text: string) => Promise<void>;
  /** 点击选择器。 */
  readonly click: (selector: string) => Promise<void>;
  /** 等表达式为真。 */
  readonly waitFor: (expression: string, timeoutMs?: number) => Promise<boolean>;
  /** 关闭连接。 */
  readonly close: () => void;
}

/** 轮询直到谓词为真（返回其值）；超时抛错。 */
async function until<T>(fn: () => T | Promise<T>, timeoutMs: number, label: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      last = await fn();
      if (last) return last as T;
    } catch (error) {
      last = `err: ${error instanceof Error ? error.message : String(error)}`;
    }
    await new Promise((tick) => setTimeout(tick, 200));
  }
  throw new Error(`超时等待：${label}（最后结果：${JSON.stringify(last)}）`);
}

/**
 * 是否要求本机必须有浏览器（CI 置 `OMNI_REQUIRE_BROWSER=1`）。
 *
 * 用途：浏览器类门禁在本地「无浏览器则 skip」是友好的，但在 CI 上跳过会让门禁**假绿**
 * （结构基线、真机 UI 回路都等于没跑）。故 CI 下把 skip 升级为显式失败。
 * @returns 要求浏览器则 true
 */
function requireBrowser(): boolean {
  return process.env['OMNI_REQUIRE_BROWSER'] === '1';
}

test('真 serve + 真 SPA + 真 Chrome：HTTP 面 + 挂载 + 一条 turns.run 全链路', async (t) => {
  if (typeof globalThis.WebSocket !== 'function') {
    if (requireBrowser()) assert.fail('CI 要求真机浏览器，但当前 Node 缺全局 WebSocket（需 ≥22）');
    t.skip('Node 缺全局 WebSocket（需 Node ≥22）');
    return;
  }
  const harness = (await import(HARNESS_URL)) as unknown as BrowserHarness;
  const browser = harness.findBrowser();
  if (browser === null) {
    // 本地开发无浏览器时跳过是友好的；但 CI 上「跳过」等于这条门禁**看着绿、实际没跑**（假绿），
    // 故 CI 用 OMNI_REQUIRE_BROWSER=1 把跳过升级为失败（见 .github/workflows/ci.yml 的 test 作业）。
    if (requireBrowser()) {
      assert.fail(
        'CI 要求真机浏览器，但 findBrowser() 未找到可执行文件（设 OMNI_CHROME_PATH 或安装 Chrome）',
      );
    }
    t.skip('未找到本机 Chrome/Edge；设 OMNI_CHROME_PATH 后重跑');
    return;
  }

  const workspaceDir = mkdtempSync(join(tmpdir(), 'omni-live-ui-ws-'));
  const storageDir = mkdtempSync(join(tmpdir(), 'omni-live-ui-sessions-'));
  const userDataDir = mkdtempSync(join(tmpdir(), 'omni-live-ui-ud-'));
  const shotDir = mkdtempSync(join(tmpdir(), 'omni-live-ui-shots-'));
  const port = await harness.getFreePort();
  let serverLog = '';
  let server: ChildProcess | undefined;
  let chrome: ChildProcess | undefined;
  let cdp: CdpSessionLike | undefined;
  try {
    server = spawn(
      process.execPath,
      [
        resolve(process.cwd(), 'dist/src/cli/exec.js'),
        'serve',
        '--port',
        String(port),
        '--model-adapter',
        'mock',
        '--approval',
        'auto',
        '--storage-dir',
        storageDir,
      ],
      // cwd = 临时工作区：既隔离配置（否则仓库 omniharness.json 会覆盖 mock 适配器），也不污染仓库。
      { cwd: workspaceDir, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    server.stdout?.on('data', (chunk) => (serverLog += String(chunk)));
    server.stderr?.on('data', (chunk) => (serverLog += String(chunk)));

    await until(
      () => /OmniHarness UI: http/.test(serverLog) || /EADDRINUSE|Error:/.test(serverLog),
      90_000,
      'serve 启动（装配内核/检索索引需要时间）',
    );
    assert.match(serverLog, /OmniHarness UI: http/, `服务端未就绪：\n${serverLog.slice(-1500)}`);
    const base = `http://127.0.0.1:${port}`;

    // ---- HTTP 面（前端能不能被真正取到、后端面是否活着）----
    const health = await fetch(`${base}/healthz`);
    assert.strictEqual(health.status, 200, '/healthz 应为 200');
    const index = await fetch(`${base}/`);
    const html = await index.text();
    assert.strictEqual(index.status, 200, '/ 应为 200');
    assert.match(html, /id="root"/, 'index.html 必须含 #root 挂载点');
    assert.match(html, /<script[^>]+src=/, 'index.html 必须引用前端 bundle');
    const metrics = await fetch(`${base}/metrics`);
    assert.match(await metrics.text(), /omni_/, '/metrics 应返回 Prometheus 指标');
    const rpc = await fetch(`${base}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'config.get', params: {} }),
    });
    const rpcBody = (await rpc.json()) as { result?: { model?: unknown } };
    assert.ok(
      typeof rpcBody.result?.model === 'string' && rpcBody.result.model.length > 0,
      'config.get 应报出当前模型',
    );

    // ---- 真 Chrome 打开真 UI ----
    const cdpPort = await harness.getFreePort();
    chrome = harness.launchChromeForCdp(browser, `${base}/`, userDataDir, cdpPort);
    cdp = new harness.CdpSession(await harness.waitForPageWs(cdpPort, '/', 40_000));
    assert.ok(await cdp.waitMounted(), 'app 必须挂载（#root 有内容）');
    const firstShot = await cdp.screenshot(join(shotDir, 'initial.png'));
    assert.ok(firstShot > 1024, `初始截图不应是空白页（len=${firstShot}）`);
    const dom = (await cdp.evaluate(`(function(){
      return {
        composer: document.querySelectorAll('.composer-input textarea').length,
        send: document.querySelectorAll('button.send').length,
        rootLen: (document.getElementById('root')||{innerHTML:''}).innerHTML.length
      };
    })()`)) as { composer: number; send: number; rootLen: number };
    assert.strictEqual(dom.composer, 1, 'composer 输入框必须存在');
    assert.strictEqual(dom.send, 1, 'send 按钮必须存在');
    assert.ok(dom.rootLen > 500, `#root 渲染内容过少（len=${dom.rootLen}）`);

    // ---- 结构基线（视觉回归的可复现判据；见 uiBaseline.ts 里「为什么不用像素」）----
    const baselinePath = resolve(process.cwd(), 'tests/integration/uiBaseline.json');
    const snapshot = await UiBaseline.capture(cdp);
    if (process.env['OMNI_UI_BASELINE_UPDATE'] === '1') {
      UiBaseline.save(baselinePath, snapshot);
      console.log(`[ui-baseline] 已重写基线：${baselinePath}`);
    } else {
      assert.ok(
        existsSync(baselinePath),
        `结构基线缺失：${baselinePath}；首次生成请跑 OMNI_UI_BASELINE_UPDATE=1 npm run test:integration`,
      );
      const verdict = UiBaseline.compare(snapshot, UiBaseline.load(baselinePath));
      assert.ok(
        verdict.ok,
        `UI 结构相对基线有变化（有意改动请用 OMNI_UI_BASELINE_UPDATE=1 重写基线并提交）：\n  - ${verdict.diffs.join('\n  - ')}`,
      );
    }

    // ---- 全链路：输入 → 发送 → 回合跑完 → UI 更新 ----
    const before = (await cdp.evaluate('document.body.innerText.length')) as number;
    await cdp.type('.composer-input textarea', '写一个 hello 函数并跑一下测试');
    await cdp.click('button.send');
    const finished = await cdp.waitFor(
      `(function(){
         return document.body.innerText.length > ${before + 20} &&
                !document.querySelector('.composer-input textarea[disabled]');
       })()`,
      90_000,
    );
    assert.ok(finished, '回合结束后页面内容应增长且输入框恢复可用（SSE 必须真的回流到 UI）');
    // 反向印证：服务端日志确有 /rpc 200 —— 防「前端自嗨、后端没跑」的假绿。
    assert.match(serverLog, /"url":"\/rpc","status":200/, '服务端日志应确认 /rpc 200');
    const afterShot = await cdp.screenshot(join(shotDir, 'after-turn.png'));
    assert.ok(afterShot > 1024, `回环后截图不应是空白页（len=${afterShot}）`);
  } finally {
    if (cdp !== undefined) cdp.close();
    if (chrome !== undefined) {
      try {
        chrome.kill('SIGKILL');
      } catch {
        /* 已退出 */
      }
    }
    if (server !== undefined) server.kill('SIGKILL');
    // Chrome/服务端退出瞬时可能仍持锁，尽力而为（残目录交 OS 回收）。
    for (const dir of [userDataDir, shotDir, storageDir, workspaceDir]) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* 锁未释放，忽略 */
      }
    }
  }
});
