// 复制按钮真机判据（2026-10-31 用户口径）：
//   · 按钮要小（本判据量 DOM 字号/内距）；
//   · 点击要有「勾选感」——但 ✓ 必须等于**真实写入剪贴板成功**，失败绝不放假勾；
//   · 成功反馈 1.4s 后自动回落到「复制」。
//
// ⚠️ 本文件是 node 环境（真 Chrome 走 CDP）：jsdom 会把全局 `WebSocket` 换成残缺实现、
// CDP 连不上——不要把带「jsdom 环境声明」的用例搬进来（ClipboardCopier 的
// 单测在 clipboardCopier.test.ts，那里才是 jsdom）。
//
// 关于重试：本机高负载时 headless Chrome 偶发**整进程干净退出**（exit 1，无渲染崩溃
// 堆栈，实测与断言无关——同流程探针连跑可活可死），表现为 CDP WebSocket 错误/关闭。
// 这是环境抖动不是产品缺陷，故对**基础设施类失败**整轮重试一次；断言失败绝不重试
// （重试掩盖真回归 = 假绿）。
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { openStubSession, stubHtmlCdp, type SkipCapableTestContext } from './browserHarness.ts';

/** 一轮完整检查。 @returns 违规描述数组（空 = 通过）。 */
async function oneRound(t: SkipCapableTestContext): Promise<string[]> {
  const overrides = {
    // 桩页推一条助手消息即可让消息卡（含复制按钮）出现。
    'sessions.list': { dir: '', sessions: [] },
  };
  const html = stubHtmlCdp().replace(
    '<div id="root"></div>',
    '<div id="root"></div>\n<script>window.__RPC_OVERRIDES__ = ' + JSON.stringify(overrides) + ';</script>',
  );
  const page = await openStubSession(t, { width: 1400, height: 900, html });
  if (page === null) return [];
  try {
    const { cdp } = page;
    await cdp.waitFor("!!document.querySelector('.composer-input textarea')", 2000);
    await cdp.push({
      method: 'thread.event',
      params: { event: { id: 'e1', sessionId: 's1', type: 'assistant', timestamp: 1, payload: { content: '复制我' } } },
    });
    if (!(await cdp.waitFor("!!document.querySelector('.copy-btn')", 3000))) {
      return ['消息卡复制按钮没有渲染'];
    }

    // 按钮要小：字号 ≤11px、纵向内距 ≤3px（调小前的口径是 11px / 3px 10px）。
    const size = (await cdp.evaluate(`(function(){
      var cs = getComputedStyle(document.querySelector('.copy-btn'));
      return { font: parseFloat(cs.fontSize), padY: parseFloat(cs.paddingTop) };
    })()`)) as { font: number; padY: number };
    const violations: string[] = [];
    if (!(size.font <= 11)) violations.push(`复制按钮字号 ${String(size.font)}px，应 ≤11px`);
    if (!(size.padY <= 3)) violations.push(`复制按钮纵向内距 ${String(size.padY)}px，应 ≤3px`);

    // ── 成功路径：Clipboard API 可用 → 点一下亮 ✓，1.4s 后回落 ──
    await cdp.evaluate(`(function(){
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: function(){ return Promise.resolve(); } }
      });
      return true;
    })()`);
    await cdp.click('.copy-btn');
    if (
      !(await cdp.waitFor(
        "document.querySelector('.copy-btn').classList.contains('copy-btn--done') && (document.querySelector('.copy-btn').textContent || '').includes('已复制')",
        500,
      ))
    ) {
      violations.push('复制成功后必须出现勾选反馈（copy-btn--done + 已复制）');
      return violations;
    }
    await new Promise((r) => setTimeout(r, 1700));
    const reverted = (await cdp.evaluate(`(function(){
      var b = document.querySelector('.copy-btn');
      return { done: b.classList.contains('copy-btn--done'), text: (b.textContent || '').trim() };
    })()`)) as { done: boolean; text: string };
    if (reverted.done) violations.push('反馈必须自动回落，不能常驻');
    if (!(reverted.text.includes('复制') && !reverted.text.includes('已复制'))) {
      violations.push(`反馈回落异常：${reverted.text}`);
    }

    // ── 失败路径：API 拒写 + execCommand 禁用 → 不得出现成功态 ──
    await cdp.evaluate(`(function(){
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: function(){ return Promise.reject(new Error('denied')); } }
      });
      document.execCommand = function(){ return false; };
      return true;
    })()`);
    await cdp.click('.copy-btn');
    await new Promise((r) => setTimeout(r, 400));
    const failed = (await cdp.evaluate(`(function(){
      var b = document.querySelector('.copy-btn');
      return { done: b.classList.contains('copy-btn--done'), text: (b.textContent || '').trim() };
    })()`)) as { done: boolean; text: string };
    if (failed.done) violations.push('两条路径都失败时绝不能亮 ✓（假成功）');
    if (failed.text.includes('已复制')) violations.push('失败时不得显示「已复制」');
    return violations;
  } finally {
    await page.close();
  }
}

test('真机：复制成功亮 ✓（copy-btn--done）并自动回落；被拒时不得出现成功态', { timeout: 180_000 }, async (t) => {
  // 高负载机器上 headless Chrome 会偶发整进程退出（exit 1、无渲染崩溃堆栈，实测与
  // 断言无关）。基础设施抖动最多重试 2 次（共 3 轮）；断言失败原样抛出，绝不重试掩盖。
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const violations = await oneRound(t);
      assert.deepStrictEqual(violations, [], '复制按钮行为不合格');
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/WebSocket/.test(msg)) throw err;
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
});
