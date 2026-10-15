// 回合变更卡片（TurnDiffCard）真浏览器验证：注入 user/assistant/turn_diff 事件流，
// 断言卡片按文件列出 + 每文件增删统计 + 点击展开 diff 正文，并截图供人眼复核。
//
// 直跑：node --test web/test/turnDiffCard.test.mjs（需先 npm run web:build）。
// 截图落盘路径可用 env OMNI_TURN_DIFF_SHOT 覆盖（默认写到 .workbuddy/ 下，不入库）。
import assert from 'node:assert/strict';
import test from 'node:test';
import { openStubSession } from './browserHarness.mjs';

/** 三文件样例 diff：改写 / 新建 / 删改混合，覆盖三种增删形态。 */
const DIFF = [
  '--- a/src/services/a.ts',
  '+++ b/src/services/a.ts',
  '@@ -1,4 +1,5 @@',
  ' import fs from "fs";',
  '-const A = 1;',
  '+const A = 2;',
  '+const B = 3;',
  ' export { A };',
  '--- a/src/services/new.ts',
  '+++ b/src/services/new.ts',
  '@@ -0,0 +1,2 @@',
  '+export const k = 1;',
  '+export const k2 = 2;',
  '--- a/README.md',
  '+++ b/README.md',
  '@@ -2,3 +2,3 @@',
  ' # 项目',
  '-旧说明',
  '+新说明',
].join('\n');

test('回合变更卡片：按文件列出 + 增删统计 + 点击展开 diff（真浏览器）', async (t) => {
  const opened = await openStubSession(t, { width: 900, height: 720 });
  if (!opened) return;
  const { cdp, close } = opened;
  try {
    await cdp.evaluate(`(function(){
      var push = window.__PUSH__;
      var n = 0;
      var ev = function(type, payload) {
        push({ method: 'thread.event', params: { event: { id: 'e' + (n++), type: type, timestamp: Date.now(), payload: payload } } });
      };
      ev('user', { content: '修复回填引擎的三个 bug' });
      ev('assistant', { content: '已修复并写入 3 个文件。' });
      ev('turn_diff', { diff: ${JSON.stringify(DIFF)} });
      return true;
    })()`);
    await new Promise((r) => setTimeout(r, 1200));

    const info = await cdp.evaluate(`(function(){
      var card = document.querySelector('.turn-diff-card');
      if (!card) return { found: false };
      return {
        found: true,
        title: (card.querySelector('.tdc-title') || {}).textContent || '',
        total: (card.querySelector('.tdc-total') || {}).textContent || '',
        toggle: (card.querySelector('.tdc-toggle') || {}).textContent || '',
        paths: Array.from(card.querySelectorAll('.tdc-path')).map(function(e){ return e.textContent; }),
        stats: Array.from(card.querySelectorAll('.tdc-stat')).map(function(e){ return e.textContent.replace(/\\s+/g, ''); }),
      };
    })()`);
    assert.equal(info.found, true, '应渲染 .turn-diff-card');
    assert.equal(info.title, '已编辑 3 个文件');
    assert.equal(info.toggle, '收起文件');
    assert.deepEqual(info.paths, ['src/services/a.ts', 'src/services/new.ts', 'README.md']);
    assert.deepEqual(info.stats, ['+2−1', '+2−0', '+1−1']);

    // 点击第一行：展开该文件 diff 正文（行级着色块 .diff 出现）。
    await cdp.click('.turn-diff-card .tdc-file:nth-child(1) .tdc-row');
    await new Promise((r) => setTimeout(r, 200));
    const body = await cdp.evaluate(
      `(function(){ var b = document.querySelector('.turn-diff-card .tdc-body .diff'); return b ? b.querySelectorAll('.add,.del').length : -1; })()`,
    );
    assert.ok(body > 0, '展开后应有行级 diff 着色块，实得 ' + body);

    // 再点收起开关：清单折叠。
    await cdp.click('.turn-diff-card .tdc-toggle');
    await new Promise((r) => setTimeout(r, 200));
    const collapsed = await cdp.evaluate(
      `(function(){ return document.querySelectorAll('.turn-diff-card .tdc-file').length; })()`,
    );
    assert.equal(collapsed, 0, '收起后不应再有文件行');

    // 重开清单 + 展开首行，截图供人眼复核。
    await cdp.click('.turn-diff-card .tdc-toggle');
    await new Promise((r) => setTimeout(r, 150));
    await cdp.click('.turn-diff-card .tdc-file:nth-child(1) .tdc-row');
    await new Promise((r) => setTimeout(r, 150));
    const shot = process.env.OMNI_TURN_DIFF_SHOT || '.workbuddy/turn-diff-card-preview.png';
    await cdp.screenshot(shot);
  } finally {
    await close();
  }
});
