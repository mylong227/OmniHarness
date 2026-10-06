#!/usr/bin/env node
/**
 * **真实场景前端跑测**（2026-10-06，第六十二轮）：真 `omniharness serve` + 真 Chrome + **真模型**。
 *
 * ## 与既有前端测试的分工（三层，互不替代）
 *
 * | 层 | 入口 | 后端 | 浏览器 | 回答什么 |
 * | --- | --- | --- | --- | --- |
 * | 组件级 | `npm run web:test`（304 例） | stub 页 + 假后端 | 部分用例真 Chrome | 前端自身有没有回归 |
 * | 集成级 | `npm run test:integration`（`liveUiE2e`） | **真 serve**（mock 模型） | 真 Chrome | 拼起来能不能跑通一条回路 |
 * | **真实场景** | **本脚本（`npm run smoke:ui`）** | **真 serve + 真线上模型** | 真 Chrome | 真人用起来会不会坏 |
 *
 * 为什么要第三层：前两层都用 mock/假后端，**永远不会踩到**「用户级 providerKeys 在 serve 的 RPC 面
 * 不可见 ⇒ Web UI 一发真回合就报未配置 API Key」这类缺陷（本轮实测抓到）。真模型还带来真流式、
 * 真工具调用、真耗时与真会话落盘，这些是 mock 给不出的。
 *
 * ## 判据（全部来自"真人会做的事"，而非内部状态）
 *
 * A 静态面与诊断：bundle/vendor/css 全 200、`/favicon.ico` 不再 404、**零控制台错误 / 零未捕获异常**
 * B 挂载与导航：composer/send/左轨/12 个右栏页签齐全，逐个切换都能渲染出内容且期间零新增错误
 * C SSE 状态：状态徽标最终为「已连接」（不是一直「重连中」）
 * D 快捷键：Ctrl+K 打开命令面板、Esc 关闭（真实按键，走 CDP Input）
 * E **真模型回合**：发送 → 观察到真流式（内容长度出现 ≥2 个递增样本）→ 出现真工具调用事件 →
 *   回合结束（输入框恢复可用）→ 助手回复非空
 * F 会话落盘与刷新恢复：`sessions.list` 含该会话且 `workspace` == 本工作区；刷新页面后历史仍在
 * G **工作区隔离**：新工作区只显示**本工作区**的会话（不得把全局存储里其它项目的会话全列出来）
 * H 真数字：`usage.stats` 有真 token 计数；「指标」页签渲染出数字
 *
 * ## 用法
 *
 * ```bash
 * npm run build && npm run web:build
 * npm run smoke:ui                    # 全部判据（真模型，耗时按分钟计）
 * node scripts/realUiScenario.mjs --only=A,B   # 只跑指定判据
 * ```
 *
 * 报告落 `.omniharness/real-ui-report.json`（gitignored）。退出码 0=全绿 / 1=有判据红。
 *
 * ## 诚实边界
 *
 * - 模型凭据取自**用户级配置**（不上命令行/日志/报告）；工作区是独立临时目录，不碰本仓源码；
 * - serve 用**随机空闲端口**（绝不占固定端口），跑完关服务与浏览器整树；
 * - 无本机 Chrome/Edge 或 Node < 22 时**显式 skip**（打印原因），绝不伪装通过。
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** 仓库根（本文件在 `scripts/` 下）。 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/** CLI 入口（构建产物）。 */
const CLI = join(ROOT, 'dist', 'src', 'cli', 'exec.js');
/** 浏览器测试脚手架（源码级 `.mjs`，不被 tsc 编译）。 */
const HARNESS = pathToFileURL(join(ROOT, 'web', 'test', 'browserHarness.mjs')).href;
/** 报告落盘位置。 */
const REPORT = join(ROOT, '.omniharness', 'real-ui-report.json');
/** 只跑指定判据（`--only=A,B`；空＝全部）。 */
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) ?? '').slice('--only='.length);

/** 逐条判据结论。 */
const checks = [];

/**
 * 记录一条判据。
 * @param id 判据 id（A/B/C…）。
 * @param name 判据描述。
 * @param ok 是否通过。
 * @param detail 失败细节（可选）。
 * @returns 无返回值。
 */
function record(id, name, ok, detail) {
  checks.push(detail === undefined ? { id, name, ok } : { id, name, ok, detail });
  process.stdout.write(
    `${ok ? '  ✓' : '  ✗'} [${id}] ${name}${ok || !detail ? '' : ` —— ${detail}`}\n`,
  );
}

/**
 * 等待谓词为真（轮询），超时返回 false。
 * @param fn 返回布尔/真值的函数。
 * @param timeoutMs 超时毫秒。
 * @param tickMs 轮询间隔（缺省 250ms；要抓**短窗口**现象时收紧，见真回合的流式采样）。
 * @returns 是否在超时前为真。
 */
async function until(fn, timeoutMs, tickMs = 250) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await fn();
      if (last) return true;
    } catch {
      /* 轮询期间页面可能在导航，忽略 */
    }
    await new Promise((tick) => setTimeout(tick, tickMs));
  }
  return false;
}

/**
 * 取一个空闲端口（绝不占固定端口）。
 * @param harness 浏览器脚手架。
 * @returns 可用端口。
 */
async function freePort(harness) {
  return harness.getFreePort();
}

/**
 * 起 serve 并等它就绪。
 * @param harness 浏览器脚手架。
 * @param ws 工作区目录。
 * @param args 额外 CLI 参数。
 * @returns `{ proc, port, base, log }`（`log` 为增量取日志的函数）。
 */
async function startServe(harness, ws, args) {
  const port = await freePort(harness);
  let text = '';
  // **必须显式给 `--workspace ws`**（2026-10-06）：serve 的根解析链是
  // `--workspace` > 本机固定项目（用户级 `~/.omniharness/omniharness.json` 的 `workspace`）> 启动目录。
  // 只靠 `cwd: ws` 会被"本机固定项目"接手 ⇒ 本电池实际跑在**开发者真实项目**上：
  // 既污染真实项目，也让 F 判据（会话应归属本工作区）假红——实测「本工作区会话 0 条」正是这个。
  const proc = spawn(
    process.execPath,
    [CLI, 'serve', '--port', String(port), '--workspace', ws, ...args],
    {
      cwd: ws,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  proc.stdout?.on('data', (chunk) => (text += String(chunk)));
  proc.stderr?.on('data', (chunk) => (text += String(chunk)));
  const ready = await until(() => /OmniHarness UI: http/.test(text), 90_000);
  if (!ready) throw new Error(`serve 未就绪：\n${text.slice(-1500)}`);
  return { proc, port, base: `http://127.0.0.1:${port}`, log: () => text };
}

/**
 * 调一次 RPC。
 * @param base 站点根。
 * @param method 方法名。
 * @param params 参数。
 * @returns RPC 的 result。
 */
async function rpc(base, method, params = {}) {
  const res = await fetch(`${base}/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
  });
  const body = await res.json();
  if (body.error !== undefined) throw new Error(`${method} 失败：${JSON.stringify(body.error)}`);
  return body.result;
}

/**
 * 主流程。
 * @returns 进程退出码。
 */
async function main() {
  const harness = await import(HARNESS);
  const browser = harness.findBrowser();
  if (browser === null) {
    process.stdout.write('跳过：未找到本机 Chrome/Edge（设 OMNI_CHROME_PATH 后重跑）\n');
    return 0;
  }
  if (typeof globalThis.WebSocket !== 'function') {
    process.stdout.write('跳过：Node 缺全局 WebSocket（需 Node >= 22）\n');
    return 0;
  }

  const ws = mkdtempSync(join(tmpdir(), 'omni-ui-real-'));
  const userDataDir = mkdtempSync(join(tmpdir(), 'omni-ui-real-ud-'));
  const storageDir = mkdtempSync(join(tmpdir(), 'omni-ui-real-sess-'));
  const shotDir = join(ROOT, '.omniharness', 'ui-shots');
  mkdirSync(shotDir, { recursive: true });
  // 项目级配置只写「模型与审批」——凭据留在**用户级**（这正是真实用户的常见配法，也是本轮缺陷现场）。
  writeFileSync(
    join(ws, 'omniharness.json'),
    `${JSON.stringify(
      { approval: 'rules', modelAdapter: 'openai', model: 'deepseek-v4-flash', reasoning: 'high' },
      null,
      2,
    )}\n`,
    'utf8',
  );
  writeFileSync(join(ws, 'notes.md'), '# 现场笔记\n\n- 目标：真实场景前端跑测\n', 'utf8');
  // 「别的项目」的会话夹具：存储目录是全局的，不塞一条进去，"工作区隔离"那条判据就是空转的。
  writeFileSync(
    join(storageDir, 'sess_foreign_fixture.jsonl'),
    `${[
      JSON.stringify({
        id: 'evt_foreign_1',
        type: 'session_meta',
        sessionId: 'sess_foreign_fixture',
        timestamp: '2026-10-06T00:00:00.000Z',
        payload: { workspace: join(tmpdir(), 'omni-some-other-project') },
      }),
      JSON.stringify({
        id: 'evt_foreign_2',
        type: 'user',
        sessionId: 'sess_foreign_fixture',
        timestamp: '2026-10-06T00:00:01.000Z',
        payload: { content: '外部项目会话：这是别的项目的对话，不该出现在本项目侧栏' },
      }),
    ].join('\n')}\n`,
    'utf8',
  );

  let serve;
  let cdp;
  let chrome;
  const want = ONLY === '' ? undefined : new Set(ONLY.split(',').map((s) => s.trim()));
  const on = (id) => want === undefined || want.has(id);
  try {
    process.stdout.write('真实场景前端跑测｜真 serve（真模型 deepseek-v4-flash）+ 真 Chrome\n');
    serve = await startServe(harness, ws, [
      '--model-adapter',
      'openai',
      '--approval',
      'rules',
      '--storage-dir',
      storageDir,
    ]);
    process.stdout.write(`  serve: ${serve.base}（工作区 ${ws}）\n`);

    const cdpPort = await freePort(harness);
    chrome = harness.launchChromeForCdp(browser, `${serve.base}/`, userDataDir, cdpPort);
    cdp = new harness.CdpSession(await harness.waitForPageWs(cdpPort, '/', 40_000));
    await cdp.startDiagnostics();
    const mounted = await cdp.waitMounted();
    record('B', 'SPA 挂载（composer + send 就位）', mounted, 'waitMounted 超时');
    if (!mounted) throw new Error('前端未挂载，后续判据无法进行');

    // ---- A 静态面与诊断 ----
    if (on('A')) {
      await new Promise((tick) => setTimeout(tick, 1500));
      const diag = cdp.diagnostics();
      const bad = diag.failedRequests.filter((r) => !/favicon\.ico/.test(r.url));
      const badFavicon = diag.failedRequests.filter((r) => /favicon\.ico/.test(r.url));
      const errors = diag.console.filter((c) => /error/i.test(String(c.type)));
      record(
        'A',
        '静态面：无资源 4xx/5xx、无 favicon 404、控制台零错误、零未捕获异常',
        bad.length === 0 &&
          badFavicon.length === 0 &&
          errors.length === 0 &&
          diag.exceptions.length === 0,
        `失败请求=${JSON.stringify(bad.concat(badFavicon).slice(0, 3))}｜控制台=${JSON.stringify(errors.slice(0, 2))}｜异常=${diag.exceptions.length}`,
      );
    }

    // ---- B 导航与页签 ----
    const tabCount = await cdp.evaluate("document.querySelectorAll('.tab[role=tab]').length");
    record('B', '右栏页签齐全（≥12）', Number(tabCount) >= 12, `实际 ${String(tabCount)} 个`);
    if (on('B')) {
      cdp.clearDiagnostics();
      const tabs = await cdp.evaluate(
        "Array.from(document.querySelectorAll('.tab[role=tab]')).map(function(e){return e.innerText.trim();})",
      );
      const broken = [];
      for (const label of tabs) {
        await cdp.evaluate(
          `(function(){var t=Array.from(document.querySelectorAll('.tab[role=tab]')).filter(function(e){return e.innerText.trim()===${JSON.stringify(label)}})[0]; if(t) t.click(); })()`,
        );
        await new Promise((tick) => setTimeout(tick, 350));
        const rendered = await cdp.evaluate(
          "(document.querySelector('.col.right .pane.active')||{innerText:''}).innerText.trim().length",
        );
        if (Number(rendered) < 2) broken.push(`${label}(空)`);
      }
      const diagAfter = cdp.diagnostics();
      const errs = diagAfter.console.filter((c) => /error/i.test(String(c.type)));
      record(
        'B',
        `逐个切换 ${String(tabs.length)} 个页签：都能渲染且有内容、期间零控制台错误`,
        broken.length === 0 && errs.length === 0 && diagAfter.exceptions.length === 0,
        `空页签=${broken.join('/')}｜错误=${JSON.stringify(errs.slice(0, 2))}`,
      );
      await cdp.screenshot(join(shotDir, 'tabs.png'));
    }

    // ---- C SSE 状态 ----
    if (on('C')) {
      const connected = await until(async () => {
        const badge = await cdp.evaluate(
          "(document.querySelector('[role=status]')||{innerText:''}).innerText",
        );
        return /已连接/.test(String(badge));
      }, 20_000);
      const badge = await cdp.evaluate(
        "(document.querySelector('[role=status]')||{innerText:''}).innerText",
      );
      record('C', 'SSE 状态徽标最终为「已连接」', connected, `实际「${String(badge).trim()}」`);
    }

    // ---- D 快捷键 ----
    if (on('D')) {
      // 面板的真实类名是 `.cmdk`（`CommandPalette.tsx`）——首版判据用 `[class*=palette]` 是**仪器假红**
      // （面板明明开着却判"没打开"），与第六十一轮 `node --test <dir>` 同一类教训。
      await cdp.press('k', { modifiers: 2, code: 'KeyK' }); // Ctrl+K
      const opened = await until(() => cdp.evaluate("!!document.querySelector('.cmdk')"), 5000);
      await cdp.press('Escape', { code: 'Escape', keyCode: 27 });
      const closed = await until(
        async () => !(await cdp.evaluate("!!document.querySelector('.cmdk')")),
        5000,
      );
      record(
        'D',
        'Ctrl+K 打开命令面板 / Esc 关闭',
        opened && closed,
        `打开=${String(opened)} 关闭=${String(closed)}`,
      );
    }

    // ---- E 真模型回合 ----
    let turnOk = false;
    if (on('E')) {
      cdp.clearDiagnostics();
      const prompt =
        '先读工作区里的 notes.md，然后把一句话结论写入 summary.txt，最后用一句话回复我。';
      await cdp.type('.composer-input textarea', prompt);
      const typed = await cdp.evaluate(
        "(document.querySelector('.composer-input textarea')||{value:''}).value",
      );
      const typedOk = String(typed).trim().length > 0;
      if (typedOk) await cdp.click('button.send');
      const samples = new Set();
      let toolEvents = 0;
      let sawWork = false;
      let sawStreamingWhileWork = false;
      // 「回合在跑」的真实信号是 `WorkIndicator`（`[class*=work]`），**不是** composer 的 disabled：
      // 实测（探针 4，逐 700ms 采样）textarea 在整个回合里 `disabled:false`，而 work 指示器
      // 1 → 0 与 `.ev.assistant` 出现严格同步。判据还必须**先看到在跑再看到收尾**——只判
      // 「输入框可用」会在发出的一瞬间就为真（用户气泡入流即让 body 变长），把"还在跑"误判成"已收尾"。
      const finished = typedOk
        ? await until(
            async () => {
              const snap = await cdp.evaluate(`(function(){
          var el = document.querySelector('.streaming-assistant .content');
          return {
            streamLen: el ? el.textContent.length : -1,
            streaming: document.querySelectorAll('.streaming-assistant').length,
            work: document.querySelectorAll('[class*=work]').length,
            tools: document.querySelectorAll('.ev.tool_call').length,
            assistant: document.querySelectorAll('.ev.assistant').length
          };
        })()`);
              if (Number(snap.streamLen) > 0) samples.add(Number(snap.streamLen));
              toolEvents = Math.max(toolEvents, Number(snap.tools));
              if (Number(snap.work) > 0) sawWork = true;
              // 真流式证据：**回合仍在跑时**就已经渲染出流式卡片（增量渲染，不是"跑完一次性贴出"）。
              if (Number(snap.work) > 0 && Number(snap.streaming) > 0) sawStreamingWhileWork = true;
              return sawWork && Number(snap.work) === 0 && Number(snap.assistant) >= 1;
            },
            180_000,
            100,
          )
        : false;
      const assistantText = await cdp.evaluate(
        "(function(){var es=document.querySelectorAll('.ev.assistant .content'); return es.length? es[es.length-1].textContent : '';})()",
      );
      const sysnote = await cdp.evaluate(
        "(function(){var es=document.querySelectorAll('.sysnote'); return es.length? es[es.length-1].innerText.slice(0,200) : '';})()",
      );
      const diag = cdp.diagnostics();
      const errs = diag.console.filter((c) => /error/i.test(String(c.type)));
      turnOk =
        typedOk &&
        finished &&
        sawStreamingWhileWork &&
        toolEvents >= 1 &&
        String(assistantText).trim().length > 0 &&
        errs.length === 0;
      record(
        'E',
        '真模型回合：回合进行中即增量渲染（真流式）+ 真工具调用 + 收尾 + 助手非空 + 零控制台错误',
        turnOk,
        `输入框取到文本=${String(typedOk)}｜收尾=${String(finished)}｜在跑时已渲染流式=${String(sawStreamingWhileWork)}｜DOM 文本长度样本=${String(samples.size)}｜工具事件=${String(toolEvents)}｜助手长度=${String(assistantText).length}｜UI 提示=${JSON.stringify(String(sysnote).slice(0, 120))}｜控制台错误=${JSON.stringify(errs.slice(0, 2))}`,
      );
      await cdp.screenshot(join(shotDir, 'after-turn.png'));
    }

    // ---- F 会话落盘与刷新恢复 ----
    if (on('F')) {
      const list = await rpc(serve.base, 'sessions.list', {});
      const mine = list.sessions.filter((s) => s.workspace === ws);
      record(
        'F',
        'sessions.list 含本工作区会话（真落盘）',
        mine.length >= 1,
        `本工作区会话 ${String(mine.length)} 条 / 全量 ${String(list.sessions.length)} 条`,
      );
      await cdp.navigate(`${serve.base}/`);
      const remounted = await cdp.waitMounted();
      const restored = remounted
        ? await until(async () => {
            await cdp.evaluate(
              "(function(){var s=document.querySelector('.session'); if(s) s.click();})()",
            );
            const n = await cdp.evaluate("document.querySelectorAll('.ev.assistant').length");
            return Number(n) >= 1;
          }, 25_000)
        : false;
      record('F', '刷新页面后历史会话仍可打开（真持久化）', restored, '刷新后未渲染出历史助手消息');
    }

    // ---- G 工作区隔离 ----
    if (on('G')) {
      // 前置：存储目录是**全局**的，故意先塞一条「其它工作区」的会话进去，否则这条判据是空转的。
      const scoped = await rpc(serve.base, 'sessions.list', {});
      const all = await rpc(serve.base, 'sessions.list', { workspace: '*' });
      const foreignId = 'sess_foreign_fixture';
      const foreignInAll = all.sessions.some((s) => s.sessionId === foreignId);
      const foreignInScoped = scoped.sessions.some((s) => s.sessionId === foreignId);
      const sidebar = String(await cdp.evaluate('document.body.innerText'));
      const sidebarLeaks = sidebar.includes('外部项目会话');
      record(
        'G',
        '会话列表按工作区收敛：别的项目的会话不进本项目的侧栏',
        foreignInAll && !foreignInScoped && !sidebarLeaks,
        `夹具在"全部"视图可见=${String(foreignInAll)}｜漏进本工作区接口=${String(foreignInScoped)}｜漏进侧栏=${String(sidebarLeaks)}`,
      );
    }

    // ---- H 真数字 ----
    if (on('H')) {
      const usage = await rpc(serve.base, 'usage.stats', {});
      const calls = Number(usage?.total?.calls ?? 0);
      record('H', 'usage.stats 报出真实 token 计数', calls > 0, `calls=${String(calls)}`);
    }

    // ---- J 宿主 API 不得被当方法调用（真机崩溃回归） ----
    // 2026-10-06 用户截图：「界面渲染出错 / Illegal invocation / at AssistantCard」。
    // 根因：`TextRevealer.tick()` 里 `this.schedule(fn, ms)`——注入的是浏览器宿主函数 `setTimeout`，
    // 以实例为 receiver 调用 ⇒ WebIDL 抛 Illegal invocation（触发条件：回合进行中 + 该助手消息未走过
    // 流式 + 正文 > 240 字）。node 里 setTimeout 不做 receiver 校验，故**只有在真浏览器里**才能测到；
    // 这正是本判据必须留在真机电池里的原因（用页面里**已发布**的模块跑一遍动画路径）。
    if (on('J')) {
      const reveal = await cdp.evaluate(`(async function(){
        try {
          var m = await import('/dist/ui/models/TextRevealer.js?v=' + Date.now());
          var frames = 0;
          var r = new m.TextRevealer(function(){ frames += 1; }, setTimeout);
          r.start('x'.repeat(500), true);
          await new Promise(function(res){ setTimeout(res, 150); });
          var running = r.running;
          r.stop();
          return { ok: true, frames: frames, running: running };
        } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
      })()`);
      record(
        'J',
        '渐进揭示器在真浏览器里不抛 Illegal invocation（宿主调度器必须裸调用）',
        reveal?.ok === true && Number(reveal.frames) >= 2,
        `ok=${String(reveal?.ok)}｜帧数=${String(reveal?.frames)}｜错误=${String(reveal?.error ?? '')}`,
      );
    }
  } catch (error) {
    record(
      'X',
      '跑测未抛异常',
      false,
      String(error instanceof Error ? error.message : error).slice(0, 400),
    );
  } finally {
    if (cdp !== undefined) cdp.close();
    harness.killChromeTree(chrome, userDataDir);
    if (serve !== undefined) serve.proc.kill('SIGKILL');
    for (const dir of [userDataDir, storageDir, ws]) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* 锁未释放，忽略 */
      }
    }
  }

  const failed = checks.filter((c) => c.ok !== true);
  writeFileSync(
    REPORT,
    `${JSON.stringify(
      {
        kind: 'real-ui-scenario',
        startedAt: new Date().toISOString(),
        model: 'deepseek-v4-flash',
        passed: failed.length === 0,
        checks,
        // 服务端日志尾部（只留最后 4000 字符）：判据变红时，现场证据与结论在同一份报告里。
        serveLogTail: serve === undefined ? '' : serve.log().slice(-4000),
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  process.stdout.write(
    `\n判据 ${String(checks.length - failed.length)}/${String(checks.length)} 通过；报告 → ${REPORT}\n`,
  );
  return failed.length === 0 ? 0 : 1;
}

process.exitCode = await main();
