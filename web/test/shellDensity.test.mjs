// 壳层「占地方」判据（2026-10-07 用户报障，真机复现 + 结构守卫）。
//
// ## 用户报的两件事
//
// ① 「左侧工作区一列不能收起来，导致无法完全显示内容区」——**真因不是按钮坏了，是按钮被挤出了列**：
//    品牌行是 `Ω + deepseek HARNESS + ⌘ + «` 四个不可收缩的 flex 子项，总宽 **284px > 列宽 248px**，
//    于是「收起»」落在列外（实测 `getBoundingClientRect().right = 284 > 248`），`elementFromPoint`
//    在它中心命中的是隔壁中栏的 `chat-title` ⇒ **看得见摸不着，点了没反应**。
//    修法：字标改本产品名（`OmniHarness`，也短了）+ 样式层让字标可收缩并带省略号，按钮 `flex:none`。
//
// ② 「进行简单文字描述或者去掉，进行悬浮冒泡提示即可，不要占地方」——输入区控制行原本常驻一句
//    权限说明（`.ctl-hint`，如「按规则自动放行安全工具」），把模型/推理/发送一排控件挤到换行。
//    修法：常驻文案删除，说明改由权限 chip 的 `title`（悬浮提示）承载，文字取**档位表自身的
//    description**（后端 `ApprovalTierCatalog` 同源），不再另存第三份文案表。
//
// ## 判据（都能对已知坏输入变红）
//
// ① 真 Chrome：收起按钮必须落在左栏可视区内、中心点必须命中它自己；点它左栏必须真的收成图标条
//    且中栏变宽（修复前实测：按钮在列外、中心点命中中栏）；
// ② 真 Chrome：品牌字标必须是 `OmniHarness`（不得再出现上游字标 `deepseek`）；
// ③ 源码守卫：输入区不得再有常驻长文案（`ctl-hint`），权限说明唯一来源是档位表。
//
// 直跑：node --test web/test/shellDensity.test.mjs（需先 npm run web:build）。
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStubSession } from './browserHarness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
/** 用户真机窗口尺寸（截图 1624×1044）——左栏是否装得下品牌行与窗口宽度直接相关。 */
const VIEWPORT = { width: 1624, height: 1044 };
/** 图标条态的左栏宽度上限（设计值 52px，留几像素余量）。 */
const RAIL_MAX_WIDTH = 60;

/**
 * 读一次壳层几何与文案。
 * @param {object} cdp CDP 会话
 * @returns {Promise<object>} 度量
 */
function readShell(cdp) {
  return cdp.evaluate(`(function(){
    var q = function(s){ return document.querySelector(s); };
    var col = q('.col.left');
    var colR = col ? col.getBoundingClientRect() : null;
    var tg = q('.rail-toggle');
    var tgR = tg ? tg.getBoundingClientRect() : null;
    var hit = null;
    if (tgR) {
      var el = document.elementFromPoint(Math.round(tgR.x + tgR.width / 2), Math.round(tgR.y + tgR.height / 2));
      hit = el ? String(el.className || el.tagName) : null;
    }
    var center = q('.col.center');
    var wordmark = q('.side-wordmark');
    return {
      leftWidth: colR ? Math.round(colR.width) : null,
      centerWidth: center ? Math.round(center.getBoundingClientRect().width) : null,
      toggleRight: tgR ? Math.round(tgR.right) : null,
      toggleInsideColumn: colR && tgR ? tgR.right <= colR.right + 0.5 : null,
      hitAtToggleCenter: hit,
      brandText: wordmark ? wordmark.textContent.trim() : null,
      wordmarkClipped: wordmark ? wordmark.scrollWidth > wordmark.clientWidth + 1 : null,
    };
  })()`);
}

/** 点一次「收起 / 展开」按钮。 @returns {Promise<void>} 无 */
async function clickRailToggle(cdp) {
  await cdp.evaluate(`(function(){ var b = document.querySelector('.rail-toggle'); if (b) b.click(); return !!b; })()`);
  await new Promise((r) => setTimeout(r, 350));
}

test('左栏「收起」按钮必须在可视区内且点得动（真 Chrome，1624×1044）', { timeout: 120_000 }, async (t) => {
  const page = await openStubSession(t, { stub: '_shell-density.html', ...VIEWPORT });
  if (page === null) return;
  try {
    const initial = await readShell(page.cdp);
    assert.ok(initial.leftWidth !== null && initial.leftWidth > 200, `左栏未展开：${JSON.stringify(initial)}`);
    assert.strictEqual(initial.brandText, 'OmniHarness', '品牌字标必须是本产品名（不是上游 deepseek）');
    assert.strictEqual(
      initial.toggleInsideColumn,
      true,
      `「收起」按钮被挤出左栏可视区（右缘 ${String(initial.toggleRight)} > 列右缘）⇒ 用户点不到：${JSON.stringify(initial)}`,
    );
    assert.match(
      String(initial.hitAtToggleCenter),
      /rail-toggle/,
      `「收起」按钮中心点命中的不是它自己（${String(initial.hitAtToggleCenter)}）⇒ 点了没反应：${JSON.stringify(initial)}`,
    );

    await clickRailToggle(page.cdp);
    const collapsed = await readShell(page.cdp);
    assert.ok(
      collapsed.leftWidth !== null && collapsed.leftWidth <= RAIL_MAX_WIDTH,
      `点「收起」后左栏必须收成图标条（≤${RAIL_MAX_WIDTH}px），实测 ${String(collapsed.leftWidth)}px`,
    );
    assert.ok(
      collapsed.centerWidth !== null &&
        initial.centerWidth !== null &&
        collapsed.centerWidth >= initial.centerWidth + 150,
      `收起后中栏必须真的变宽（内容区才显示得全）：${String(initial.centerWidth)} → ${String(collapsed.centerWidth)}`,
    );
    assert.match(
      String(collapsed.hitAtToggleCenter),
      /rail-toggle/,
      '图标条态下「展开»」也必须点得动（否则收起来就出不去了）',
    );

    await clickRailToggle(page.cdp);
    const reopened = await readShell(page.cdp);
    assert.ok(
      reopened.leftWidth !== null && reopened.leftWidth > 200,
      `再点一次必须展开回原宽：实测 ${String(reopened.leftWidth)}px`,
    );
  } finally {
    await page.close();
  }
});

test('接线守卫：输入区不得有常驻长文案，权限说明只走悬浮提示（唯一来源 = 档位表）', () => {
  const composer = readFileSync(join(HERE, '..', 'src', 'ui', 'components', 'Composer.tsx'), 'utf8');
  const picker = readFileSync(join(HERE, '..', 'src', 'ui', 'components', 'PermissionPicker.tsx'), 'utf8');
  const options = readFileSync(join(HERE, '..', 'src', 'ui', 'models', 'ComposerOptions.ts'), 'utf8');
  assert.doesNotMatch(
    composer,
    /ctl-hint/,
    '输入区不得再渲染常驻权限文案（用户实测：它把模型/推理/发送一排控件挤到换行）',
  );
  assert.match(composer, /<PermissionPicker\b/, '权限档位选择器仍必须在输入区里（只是不再外挂长文案）');
  assert.match(
    picker,
    /active\.description/,
    '悬浮说明必须取档位表自身的 description（与后端 ApprovalTierCatalog 同源）',
  );
  assert.doesNotMatch(
    options,
    /PERMISSION_HINTS|permissionHint/,
    '同一句权限说明不得再存第三份（后端档位表 + 前端兜底表已各有一份）',
  );
});
