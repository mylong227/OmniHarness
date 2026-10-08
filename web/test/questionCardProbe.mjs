// 提问卡的**真实浏览器**验收（2026-10-08 用户报障）：在真 Chrome 里「推一条 question.request → 点选项 → 点提交」，
// 断言 RPC 真的发出去了、载荷就是用户点的那一项。
//
// 为什么除了零 DOM 单测还要这一层：`questionCard.test.mjs` 判的是 vnode 结构与回调，判不了
// 「真浏览器里这张卡是否可见、真的能点、点完真的发 RPC」——而用户报障的原话正是「选择无法提交」。
//
// **为什么是 probe 而不是 `*.test.mjs`**：本仓的 `web:test` 用 `web/test/**/*.test.mjs` 一次并行起全部用例，
// 而 `chromeCleanup.test.mjs` 会**数全机 Chrome 进程**来判「收尾是否终止整棵树」——再来一个并发起浏览器的
// 用例会让它误判（本机实测：单独跑全绿，并行跑必红）。故与 `responsiveProbe.mjs` / `visualProbe.mjs` /
// `virtualProbe.mjs` 同一形态：**独立探针**，按需显式运行：
//     node --test web/test/questionCardProbe.mjs
// 无浏览器时显式 skip（不伪装通过）；可用 OMNI_CHROME_PATH 指定浏览器。
// 需要留图复核时设 OMNI_QASK_SHOT=<路径>，本探针会把提问卡截图写到该路径。

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findBrowser,
  serveStatic,
  stubHtmlCdp,
  getFreePort,
  launchChromeForCdp,
  killChromeTree,
  waitForPageWs,
  CdpSession,
  WEB_ROOT_PATH,
} from './browserHarness.mjs';

const STUB_NAME = '_question-card-cdp.html';

/** 推给页面的提问（两题：单选 + 无选项自由输入）。 */
const QUESTION_REQUEST = {
  method: 'question.request',
  params: {
    requestId: 'qst_cdp_1',
    sessionId: 't-cdp',
    timeoutMs: 0,
    questions: [
      {
        id: 'scope',
        header: '确认任务范围',
        question: '这次做哪一种？',
        options: [
          { label: '历史 + 冗余问题', description: '先梳理历史演化，再找重复与冗余' },
          { label: '只排查冗余/重复', description: '只做去重体检' },
        ],
      },
    ],
  },
};

test('CDP：提问卡在真浏览器里可见可点，提交发出 question.respond 且载荷含所选标签', async (t) => {
  const browser = findBrowser();
  if (!browser) {
    t.skip('未找到本机 Chrome/Edge；设 OMNI_CHROME_PATH 指定浏览器可执行文件后重跑');
    return;
  }
  if (typeof globalThis.WebSocket !== 'function') {
    t.skip('Node 缺全局 WebSocket（需 Node >= 22）');
    return;
  }

  const server = await serveStatic(WEB_ROOT_PATH, { [`/${STUB_NAME}`]: stubHtmlCdp() });
  const userDataDir = mkdtempSync(join(tmpdir(), 'omni-qask-ud-'));
  const shotDir = mkdtempSync(join(tmpdir(), 'omni-qask-shots-'));
  let cdp;
  let proc;
  try {
    const port = await getFreePort();
    const url = `http://127.0.0.1:${server.port}/${STUB_NAME}`;
    proc = launchChromeForCdp(browser, url, userDataDir, port);
    cdp = new CdpSession(await waitForPageWs(port, STUB_NAME));
    assert.ok(await cdp.waitMounted(), 'app 未挂载');

    // 记录**完整**入参（stub 自带的 __RPC_CALLS__ 只记方法名，判不了「提交的那一项是哪个」）。
    await cdp.evaluate(`(function(){
      var calls = [];
      window.__QASK_CALLS__ = calls;
      var inner = window.fetch;
      window.fetch = function(url, opts){
        try {
          var body = JSON.parse((opts && opts.body) || '{}');
          if (String(url).indexOf('/rpc') >= 0) calls.push({ method: body.method, params: body.params });
        } catch (e) {}
        return inner.apply(this, arguments);
      };
      return true;
    })()`);

    await cdp.push(QUESTION_REQUEST);
    assert.ok(await cdp.waitFor("!!document.querySelector('.qask')"), '提问卡未出现');
    const text = await cdp.evaluate("document.querySelector('.qask').textContent");
    assert.match(text, /确认任务范围/, '提问卡必须显示题目标题');
    assert.match(text, /只排查冗余\/重复/, '选项说明必须可见');
    assert.strictEqual(
      await cdp.evaluate("document.querySelectorAll('.qask-option').length"),
      2,
      '两个选项都要渲染成控件',
    );
    const submitDisabled = await cdp.evaluate(
      "document.querySelector('.qask-submit').disabled",
    );
    assert.strictEqual(submitDisabled, true, '未作答时提交必须禁用');

    // 真鼠标点第一个选项
    await cdp.click('.qask-option');
    assert.strictEqual(
      await cdp.evaluate("document.querySelector('.qask-option').getAttribute('aria-checked')"),
      'true',
      '点击后选项必须进入选中态',
    );
    if (process.env.OMNI_QASK_SHOT) {
      await cdp.screenshot(process.env.OMNI_QASK_SHOT);
    }
    // 真鼠标点提交
    await cdp.click('.qask-submit');
    assert.ok(
      await cdp.waitFor(
        "window.__QASK_CALLS__.some(function(c){ return c.method === 'question.respond'; })",
      ),
      '点击提交后必须发出 question.respond',
    );
    const sent = await cdp.evaluate(
      "window.__QASK_CALLS__.filter(function(c){ return c.method === 'question.respond'; })[0]",
    );
    assert.strictEqual(sent.params.requestId, 'qst_cdp_1');
    assert.deepStrictEqual(sent.params.answers, [
      { id: 'scope', selected: ['历史 + 冗余问题'], custom: '' },
    ]);
    assert.ok(
      await cdp.waitFor("!document.querySelector('.qask')"),
      '提交后提问卡必须收起（否则用户会以为没提交上）',
    );
    if (process.env.OMNI_E2E_VERBOSE === '1') {
      console.error('[question-card-cdp] shot dir: ' + shotDir);
    }
  } finally {
    if (cdp) cdp.close();
    killChromeTree(proc, userDataDir);
    await server.close();
    for (const dir of [userDataDir, shotDir]) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* 锁未释放，忽略 */
      }
    }
  }
});
