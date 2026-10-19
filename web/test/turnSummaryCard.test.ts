// 回合结果卡（TurnSummaryCard）真浏览器验证：注入 user / 写类工具 / assistant / turn_diff 事件流，
// 断言「生成的文件」「修改的文件」两组、增删统计、图片产物补位、点击展开差异与整体收起，并截图留档。
//
// 直跑：node --test web/test/turnSummaryCard.test.ts（需先 npm run web:build）。
// 截图落盘路径可用 env OMNI_TURN_SUMMARY_SHOT 覆盖（默认写到 .workbuddy/ 下，不入库）。
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { openStubSession } from './browserHarness.ts';

/** 三文件样例 diff：一个新建、两个改写（覆盖 create / modify 两组的增删形态）。 */
const DIFF = [
  '--- a/docs/plan.md',
  '+++ b/docs/plan.md',
  '@@ -0,0 +1,2 @@',
  '+# 计划',
  '+结果统一收口。',
  '--- a/web/src/ui/components/StreamView.tsx',
  '+++ b/web/src/ui/components/StreamView.tsx',
  '@@ -1,2 +1,3 @@',
  ' const a = 1;',
  '-const b = 2;',
  '+const b = 3;',
  '+const c = 4;',
  '--- a/web/styles/minimal.css',
  '+++ b/web/styles/minimal.css',
  '@@ -1,1 +1,2 @@',
  ' /* x */',
  '+.turn-summary {}',
].join('\n');

test('回合结果卡：生成/修改分组 + 增删统计 + 打开/下载/差异（真浏览器）', async (t) => {
  const opened = await openStubSession(t, { width: 900, height: 760 });
  if (!opened) return;
  const { cdp, close } = opened;
  try {
    await cdp.evaluate(`(function(){
      var push = window.__PUSH__;
      var n = 0;
      var base = Date.now();
      var ev = function(type, payload) {
        var i = n++;
        push({ method: 'thread.event', params: { event: { id: 'e' + i, type: type, timestamp: base + i * 1000, payload: payload } } });
      };
      ev('user', { content: '把会话页的结果汇总重做一下' });
      ev('tool_call', { callId: 'c1', name: 'write_file', args: { path: 'docs/plan.md' } });
      ev('tool_result', { callId: 'c1', ok: true, output: '已写入 docs/plan.md' });
      ev('tool_call', { callId: 'c2', name: 'apply_patch', args: { path: 'web/src/ui/components/StreamView.tsx' } });
      ev('tool_result', { callId: 'c2', ok: true, output: '补丁已应用' });
      ev('tool_call', { callId: 'c3', name: 'sketch_write', args: { title: 'turn-summary' } });
      ev('tool_result', { callId: 'c3', ok: true, output: '草图已保存: web/archive/turn-summary.png（1280×900）' });
      ev('assistant', { content: '已完成汇总。' });
      ev('turn_diff', { diff: ${JSON.stringify(DIFF)} });
      return true;
    })()`);
    await new Promise((r) => setTimeout(r, 1200));

    const info = await cdp.evaluate(`(function(){
      var card = document.querySelector('.turn-summary');
      if (!card) return { found: false };
      var text = function(sel) {
        var el = card.querySelector(sel);
        return el ? el.textContent.replace(/\\s+/g, ' ').trim() : '';
      };
      return {
        found: true,
        title: text('.ts-title'),
        counts: text('.ts-counts'),
        time: text('.ts-time'),
        groups: Array.from(card.querySelectorAll('.ts-group-name')).map(function(e){ return e.textContent; }),
        created: Array.from(card.querySelectorAll('.ts-file.created .ts-name')).map(function(e){ return e.textContent; }),
        modified: Array.from(card.querySelectorAll('.ts-file.modified .ts-name')).map(function(e){ return e.textContent; }),
        stats: Array.from(card.querySelectorAll('.ts-stat')).map(function(e){ return e.textContent.replace(/\\s+/g, ''); }),
        kinds: Array.from(card.querySelectorAll('.ts-kind')).map(function(e){ return e.textContent; }),
        downloads: Array.from(card.querySelectorAll('.ts-actions a')).map(function(e){ return e.getAttribute('href'); }),
      };
    })()`);
    assert.strictEqual(info.found, true, '应渲染 .turn-summary');
    assert.strictEqual(info.title, '本轮结果');
    assert.strictEqual(info.counts, '生成 2 · 修改 2');
    assert.strictEqual(info.time, '耗时 8秒', '本轮耗时必须按 时/分/秒 格式化并汇总进结果卡');
    assert.deepEqual(info.groups, ['生成的文件', '修改的文件']);
    assert.deepEqual(info.created, ['plan.md', 'turn-summary.png']);
    assert.deepEqual(info.modified, ['StreamView.tsx', 'minimal.css']);
    assert.deepEqual(info.stats, ['+2', '+2−1', '+1']);
    assert.deepEqual(info.kinds, ['图片']);
    assert.deepEqual(info.downloads, [
      '/files?path=docs%2Fplan.md',
      '/files?path=web%2Farchive%2Fturn-summary.png',
      '/files?path=web%2Fsrc%2Fui%2Fcomponents%2FStreamView.tsx',
      '/files?path=web%2Fstyles%2Fminimal.css',
    ]);

    // 结果卡挂载后必须被自动带进视口：底部圆角/细线封口完整可见（用户报「缺了封口」）。
    const geom = await cdp.evaluate(`(function(){
      var s = document.querySelector('.stream');
      var c = document.querySelector('.turn-summary');
      if (!s || !c) return { ok: false };
      var sr = s.getBoundingClientRect();
      var cr = c.getBoundingClientRect();
      return {
        ok: true,
        scrollTop: s.scrollTop,
        maxScroll: s.scrollHeight - s.clientHeight,
        cardBottom: cr.bottom,
        streamBottom: sr.bottom,
      };
    })()`);
    assert.strictEqual(geom.ok, true);
    assert.ok(
      Number(geom.scrollTop) >= Number(geom.maxScroll) - 1,
      '结果卡出现后应贴底：' + JSON.stringify(geom),
    );
    assert.ok(
      Number(geom.cardBottom) <= Number(geom.streamBottom) + 1,
      '结果卡底部（圆角细线封口）必须完整露出：' + JSON.stringify(geom),
    );

    // 点击第一条「修改的文件」主体：就地展开 diff 正文。
    await cdp.click('.ts-file.modified .ts-main');
    await new Promise((r) => setTimeout(r, 200));
    const body = await cdp.evaluate(
      `(function(){ var b = document.querySelector('.turn-summary .ts-diff .diff'); return b ? b.querySelectorAll('.add,.del').length : -1; })()`,
    );
    assert.ok(body > 0, '展开后应有行级 diff 着色块，实得 ' + body);

    // 整体收起 / 再展开。
    await cdp.click('.turn-summary .ts-toggle');
    await new Promise((r) => setTimeout(r, 200));
    const collapsed = await cdp.evaluate(
      `(function(){ return document.querySelectorAll('.turn-summary .ts-file').length; })()`,
    );
    assert.strictEqual(collapsed, 0, '收起后不应再有文件行');
    await cdp.click('.turn-summary .ts-toggle');
    await new Promise((r) => setTimeout(r, 150));

    const shot = process.env.OMNI_TURN_SUMMARY_SHOT || '.workbuddy/turn-summary-card-preview.png';
    await cdp.screenshot(shot);
  } finally {
    await close();
  }
});

test('非标准 diff：退回原始 diff 呈现，不静默吞内容（真浏览器）', async (t) => {
  const opened = await openStubSession(t, { width: 760, height: 600 });
  if (!opened) return;
  const { cdp, close } = opened;
  try {
    await cdp.evaluate(`(function(){
      var push = window.__PUSH__;
      var ev = function(id, type, payload) {
        push({ method: 'thread.event', params: { event: { id: id, type: type, timestamp: Date.now(), payload: payload } } });
      };
      ev('u1', 'user', { content: '看一下这段差异' });
      ev('d1', 'turn_diff', { diff: '这不是标准 diff\\n+但仍然是内容' });
      return true;
    })()`);
    await new Promise((r) => setTimeout(r, 800));
    const info = await cdp.evaluate(
      `(function(){ var box = document.querySelector('.turn-summary .ts-fallback .diff'); return box ? box.textContent : null; })()`,
    );
    assert.ok(typeof info === 'string' && info.includes('这不是标准 diff'), '应原样呈现无法解析的 diff');
  } finally {
    await close();
  }
});
