// 壳层「占地方」判据（2026-10-07 用户报障 → 2026-10-26 按钮删除后的回归）。
//
// ## 历史与现状
//
// 2026-10-07 用户报「左侧工作区一列不能收起来」：真因是品牌行 `Ω + 字标 + ⌘ + «` 总宽 284px
// 超过列宽 248px，收起按钮被挤出列外。修法是缩短字标 + 可收缩省略号 + 按钮 flex:none。
//
// 2026-10-26 用户按参考图要求：**删掉品牌行的命令面板按钮**（`«` 收起按钮保留），同时右栏
// 头的「全部面板」按钮也删除。命令面板仍可用 Ctrl/Cmd+P；左栏图标条仍可由 `«` / `[` 切换。
// 因此本轮判据改成：
//   ① 真机：品牌行没有任何按钮（命令 / 收起都不在），字标不被挤掉；
//   ② 真机：`[` 仍能把左栏收成图标条并恢复；
//   ③ 源码守卫：输入区不得再有常驻长文案（与本次无关，保留原判据）。
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStubSession, type CdpSession } from './browserHarness.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
/** 用户真机窗口尺寸（截图 1624×1044）。 */
const VIEWPORT = { width: 1624, height: 1044 };
/** 图标条态的左栏宽度上限（设计值 52px，留几像素余量）。 */
const RAIL_MAX_WIDTH = 60;

/** readShell 页面脚本的单次度量结果。 */
interface ShellMetrics {
  leftWidth: number | null;
  centerWidth: number | null;
  headerButtons: number;
  hasRailToggle: boolean;
  commandButtons: number;
  brandText: string | null;
  brandTag: string | null;
  wordmarkClipped: boolean | null;
}

/**
 * 读一次壳层几何与文案。
 * @param cdp CDP 会话
 * @returns 度量
 */
function readShell(cdp: CdpSession): Promise<ShellMetrics> {
  return cdp.evaluate(`(function(){
    var q = function(s){ return document.querySelector(s); };
    var col = q('.col.left');
    var colR = col ? col.getBoundingClientRect() : null;
    var center = q('.col.center');
    var wordmark = q('.side-wordmark');
    var wordmarkText = q('.side-wordmark-text') || wordmark;
    var wordmarkTag = q('.side-wordmark-tag');
    var brand = q('.side-brand');
    return {
      leftWidth: colR ? Math.round(colR.width) : null,
      centerWidth: center ? Math.round(center.getBoundingClientRect().width) : null,
      headerButtons: brand ? brand.querySelectorAll('button').length : -1,
      hasRailToggle: q('.rail-toggle') !== null,
      commandButtons: document.querySelectorAll('button[aria-label="打开命令面板"]').length,
      // 扫光层是 aria-hidden 的重复文字；读品牌名要取无装饰的文本节点。
      brandText: wordmarkText ? wordmarkText.textContent.trim() : null,
      brandTag: wordmarkTag ? wordmarkTag.textContent.trim() : null,
      wordmarkClipped: wordmark ? wordmark.scrollWidth > wordmark.clientWidth + 1 : null,
    };
  })()`) as Promise<ShellMetrics>;
}

/**
 * 按一次 `[`（左栏图标条快捷键）。
 * @param cdp CDP 会话
 * @returns 无
 */
async function pressRailKey(cdp: CdpSession): Promise<void> {
  const base = {
    key: '[',
    code: 'BracketLeft',
    windowsVirtualKeyCode: 219,
    nativeVirtualKeyCode: 219,
  };
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  await new Promise((r) => setTimeout(r, 350));
}

test('品牌行只留字标：命令/收起按钮已删除，`[` 仍可切换图标条', { timeout: 120_000 }, async (t) => {
  const page = await openStubSession(t, { stub: '_shell-density.html', ...VIEWPORT });
  if (page === null) return;
  try {
    const initial = await readShell(page.cdp);
    assert.ok(
      initial.leftWidth !== null && initial.leftWidth > 200,
      `左栏未展开：${JSON.stringify(initial)}`,
    );
    assert.strictEqual(initial.brandText, 'Omni', '品牌主标题必须是 Omni（不是上游品牌）');
    assert.strictEqual(initial.brandTag, 'HARNESS', '品牌副标必须是大写 HARNESS 且与主标题分开');
    assert.strictEqual(initial.hasRailToggle, false, '品牌行的「收起»」按钮必须已删除（2026-10-26）');
    assert.strictEqual(initial.headerButtons, 0, '品牌行不得再有命令/收起按钮');
    assert.strictEqual(initial.commandButtons, 0, '命令面板按钮必须已删除（快捷键仍可用）');
    assert.strictEqual(initial.wordmarkClipped, false, '字标不得被挤到省略（列宽足够）');

    await pressRailKey(page.cdp);
    const collapsed = await readShell(page.cdp);
    assert.ok(
      collapsed.leftWidth !== null && collapsed.leftWidth <= RAIL_MAX_WIDTH,
      `按 [ 后左栏必须收成图标条（≤${RAIL_MAX_WIDTH}px），实测 ${String(collapsed.leftWidth)}px`,
    );
    assert.ok(
      collapsed.centerWidth !== null &&
        initial.centerWidth !== null &&
        collapsed.centerWidth >= initial.centerWidth + 150,
      `图标条态必须让中栏变宽：${String(initial.centerWidth)} → ${String(collapsed.centerWidth)}`,
    );

    await pressRailKey(page.cdp);
    const reopened = await readShell(page.cdp);
    assert.ok(
      reopened.leftWidth !== null && reopened.leftWidth > 200,
      `再按 [ 必须展开回原宽：实测 ${String(reopened.leftWidth)}px`,
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
