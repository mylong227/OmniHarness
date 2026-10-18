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
 * ## 隔离与零副作用（三个刻意的选择）
 *
 * 1. **显式 `--workspace` = 临时工作区**（2026-10-06 补）：serve 的根解析是
 *    `--workspace` > 本机固定项目（`~/.omniharness/omniharness.json` 的 `workspace`）> 启动目录。
 *    只把 cwd 设成临时目录**挡不住**"本机固定项目"——开发机上一旦固定过项目，本测试就会被改道到
 *    那个真实项目（实测：空态基线漂移，且等于拿用户项目当测试场地）。故必须**显式**给 `--workspace`。
 * 2. **cwd 也设成临时工作区**：项目级 `omniharness.json` 在这里向上查找；若在仓库根起，
 *    仓库自己的配置（openai + providerKeys）会**覆盖** `--model-adapter mock` ⇒ 变成真实模型回合
 *    （实测：真跑出 12 步、在仓库里写了 `src/hello.ts` 与单测）。隔离后零额度、零副作用、可复现。
 * 3. **storage 目录也指向临时目录**：不污染 `~/.omniharness/sessions`。
 *
 * ## 生物级前提与跳过语义
 *
 * 需要本机 Chrome/Edge（`OMNI_CHROME_PATH` 可指定）与 Node ≥22 的全局 WebSocket；缺任一则
 * **显式 skip**（打印原因），绝不伪装通过。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { UiBaseline } from './uiBaseline.ts';

// 浏览器测试脚手架：**静态导入**（2026-10-17 迁移后）。
//
// 旧写法是 `await import(pathToFileURL(...browserHarness.mjs))`：那时它是源码级 `.mjs`、
// 不被 tsc 编译，只能按项目根定位再动态 import。迁移到 `.ts` 后这条路走不通——
// 裸 file URL 会绕过 Vitest 的转换管线直接交给 Node，而 Node 不认 `.ts`
//（`Unknown file extension ".ts"`，且因为写在用例内部，看起来像"脚手架缺依赖"）。
// 静态导入由 Vitest 正常转换，顺带让下面两个手写接口变得多余。
import {
  CdpSession,
  findBrowser,
  getFreePort,
  killChromeTree,
  launchChromeForCdp,
  waitForPageWs,
} from '../../web/test/browserHarness.ts';

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
    t.skip(); // Node 缺全局 WebSocket（需 Node ≥22）
    return;
  }
  const harness = {
    CdpSession,
    findBrowser,
    getFreePort,
    killChromeTree,
    launchChromeForCdp,
    waitForPageWs,
  };
  const browser = harness.findBrowser();
  if (browser === null) {
    // 本地开发无浏览器时跳过是友好的；但 CI 上「跳过」等于这条门禁**看着绿、实际没跑**（假绿），
    // 故 CI 用 OMNI_REQUIRE_BROWSER=1 把跳过升级为失败（见 .github/workflows/ci.yml 的 test 作业）。
    if (requireBrowser()) {
      assert.fail(
        'CI 要求真机浏览器，但 findBrowser() 未找到可执行文件（设 OMNI_CHROME_PATH 或安装 Chrome）',
      );
    }
    t.skip(); // 未找到本机 Chrome/Edge；设 OMNI_CHROME_PATH 后重跑
    return;
  }

  const workspaceDir = mkdtempSync(join(tmpdir(), 'omni-live-ui-ws-'));
  // 假家目录：serve 会读用户级 `~/.omniharness/omniharness.json`（真实用户的偏好如 locale 会
  // 渗入首帧 ⇒ 结构基线误红）。与下方 env.USERPROFILE/HOME 配套，见 spawn 处注释。
  const fakeHome = mkdtempSync(join(tmpdir(), 'omni-live-ui-home-'));
  const storageDir = mkdtempSync(join(tmpdir(), 'omni-live-ui-sessions-'));
  const userDataDir = mkdtempSync(join(tmpdir(), 'omni-live-ui-ud-'));
  const shotDir = mkdtempSync(join(tmpdir(), 'omni-live-ui-shots-'));
  const port = await harness.getFreePort();
  let serverLog = '';
  let server: ChildProcess | undefined;
  let chrome: ChildProcess | undefined;
  let cdp: CdpSession | undefined;
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
        // 显式指定工作区：否则"本机固定项目"（用户级配置）会把本测试改道到**真实项目**上（见文件头 §1）。
        '--workspace',
        workspaceDir,
      ],
      // cwd = 临时工作区：既隔离配置（否则仓库 omniharness.json 会覆盖 mock 适配器），也不污染仓库。
      {
        cwd: workspaceDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        // **用户级配置隔离**（2026-10-17）：serve 的分层加载会读本机 `~/.omniharness/omniharness.json`，
        // 用户的真实偏好（实测：locale:'en'）会改道 SPA 首帧语言 ⇒ 结构基线误红。
        // USERPROFILE/HOME 指向临时空家目录后，用户级/凭据保险库全部落在测试私有目录。
        env: { ...process.env, USERPROFILE: fakeHome, HOME: fakeHome },
      },
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
    // 面板入口已随壳层重构收进 `PanelPicker` 菜单（旧左竖条 `NavRail` 已删除，旧的
    // `railItems` 因此恒为 0 = 假绿）⇒ **先真实展开菜单再采集**，并在此处自证"菜单真的开了"：
    // 采到空数组会让 panelMenuItems 那条判据整体退化，必须在这里就红。
    await cdp.click('.pp-btn');
    const menuOpen = await cdp.waitFor(
      "document.querySelectorAll('.pp-menu .pp-item').length >= 12",
      8_000,
    );
    assert.ok(
      menuOpen,
      '面板菜单（PanelPicker）必须能展开且至少 12 个入口 —— 采不到入口会让结构基线退化成假绿',
    );
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
    // 收起菜单：后面还要真实输入并点发送，浮层残留在屏幕上会干扰真实坐标点击。
    await cdp.click('.pp-btn');
    assert.ok(
      await cdp.waitFor("!document.querySelector('.pp-menu .pp-item')", 5_000),
      '面板菜单必须能收起（浮层残留会挡住后续的真实点击）',
    );

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
    // 整树终止（实测：只 `chrome.kill('SIGKILL')` 会在 Windows 上留下浏览器 + 渲染/gpu 子进程，
    // 反复跑集成会在几分钟内堆到几十个进程 / GB 级内存 —— 正是「偶发失败」的温床）。
    harness.killChromeTree(chrome, userDataDir);
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
