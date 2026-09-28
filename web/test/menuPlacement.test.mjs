// 右键菜单**贴边翻转**门禁（零 DOM、确定性）：菜单任何情况下都必须完整落在视口内。
//
// ## 缺陷形态（2026-09-27 用户点名）
//
// 菜单按鼠标坐标 `position:fixed` 放：鼠标在视口右下角时 `left/top` 直接等于坐标 ⇒ 菜单右半边 /
// 下半截跑到屏幕外，「删除…」等项点不到。做法与系统右键菜单一致：放不下就朝反方向翻，
// 翻完仍放不下则夹到留白内。
//
// 直跑：node --test web/test/menuPlacement.test.mjs（需先 npm run web:build）。
import assert from 'node:assert/strict';
import test from 'node:test';

const { MenuPlacement } = await import('../dist/ui/models/MenuPlacement.js');

/** 视口（常见尺寸）。 */
const VIEW = { w: 1280, h: 800 };
/** 菜单尺寸（实测约 132×150）。 */
const MENU = { w: 132, h: 150 };

test('常规位置：贴鼠标右下方向，不翻不夹', () => {
  assert.deepStrictEqual(MenuPlacement.clamp(200, 200, MENU, VIEW), { x: 200, y: 200 });
});

test('右边缘：向左翻（菜单右缘对齐鼠标）', () => {
  const p = MenuPlacement.clamp(1240, 200, MENU, VIEW);
  assert.strictEqual(p.x, 1240 - MENU.w, '应向左翻，而不是溢出右边缘');
  assert.ok(p.x + MENU.w <= VIEW.w, '整个菜单必须在视口内');
});

test('下边缘：向上翻（菜单下缘对齐鼠标）', () => {
  const p = MenuPlacement.clamp(200, 780, MENU, VIEW);
  assert.strictEqual(p.y, 780 - MENU.h);
  assert.ok(p.y + MENU.h <= VIEW.h);
});

test('右下角（用户点名的场景）：两个方向同时翻，整个菜单可见', () => {
  const p = MenuPlacement.clamp(1272, 792, MENU, VIEW);
  assert.ok(p.x >= 0 && p.x + MENU.w <= VIEW.w, `水平方向必须完整可见，实测 ${JSON.stringify(p)}`);
  assert.ok(p.y >= 0 && p.y + MENU.h <= VIEW.h, `垂直方向必须完整可见，实测 ${JSON.stringify(p)}`);
});

test('贴左上角：不得越过留白（菜单不贴死边缘）', () => {
  const p = MenuPlacement.clamp(0, 0, MENU, VIEW);
  assert.ok(p.x >= 8 && p.y >= 8, '左上角也要留出 8px 留白');
});

test('菜单比视口还大：夹到左上留白（此时必然溢出，但保证左/上可见）', () => {
  const p = MenuPlacement.clamp(600, 400, { w: 2000, h: 2000 }, VIEW);
  assert.deepStrictEqual(p, { x: 8, y: 8 });
});

test('接线守卫：左栏菜单必须走 MenuPlacement（不得直接写鼠标坐标）', async () => {
  const { readFileSync } = await import('node:fs');
  const { dirname, join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const here = dirname(fileURLToPath(import.meta.url));
  const panel = readFileSync(join(here, '..', 'src', 'ui', 'components', 'SessionPanel.tsx'), 'utf8');
  assert.match(panel, /MenuPlacement\.clamp\(/, '菜单定位必须走 MenuPlacement.clamp');
  assert.match(panel, /menuRef/, '必须先量出菜单真实宽高再翻转');
});
