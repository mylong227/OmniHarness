// 空洞修复预算门禁（零 DOM、确定性）：给「因修复而 setState」一个**结构上可证**的上界。
//
// ## 为什么需要（2026-09-27 用户截图的 React #185「Maximum update depth exceeded」）
//
// 空洞修复会 setState；setState 会重算窗口并让布局效应再跑一次；只要「修完覆盖率仍不达标」一直
// 成立，就形成 `render → layoutEffect → setState → render` 的**同步**循环（React 抛 #185、
// 页面主线程被占满）。几何上「本该收敛」不足以保证（实测有会话状态不收敛），故必须有预算：
// **预算只在用户自己滚动时补充** ⇒ 循环无法自我续期。
//
// 直跑：node --test web/test/scrollRepairBudget.test.mjs（需先 npm run web:build）。
import assert from 'node:assert/strict';
import test from 'node:test';

const { ScrollRepairBudget } = await import('../dist/ui/models/ScrollRepairBudget.js');

test('默认预算：允许 2 次修复，第 3 次拒绝', () => {
  const b = new ScrollRepairBudget();
  assert.strictEqual(b.take(), true);
  assert.strictEqual(b.take(), true);
  assert.strictEqual(b.take(), false, '预算耗尽后必须拒绝（否则可无限 setState）');
  assert.strictEqual(b.remainingCount(), 0);
});

test('用户滚动 ⇒ 补满预算', () => {
  const b = new ScrollRepairBudget(2);
  b.take();
  b.take();
  assert.strictEqual(b.take(), false);
  b.noteScroll();
  assert.strictEqual(b.take(), true, '用户滚动后应重新获得预算');
  assert.strictEqual(b.remainingCount(), 1);
});

test('max <= 0 ⇒ 彻底禁用修复', () => {
  const b = new ScrollRepairBudget(0);
  assert.strictEqual(b.take(), false);
  b.noteScroll();
  assert.strictEqual(b.take(), false);
});

test('死循环模拟：修复不收敛时，setState 次数必须在 max 次内终止', () => {
  const b = new ScrollRepairBudget(2);
  let steps = 0;
  // 最坏情形：每一轮修复后覆盖率依旧不达标（几何永不收敛）
  for (let i = 0; i < 1000; i++) {
    if (!b.take()) break;
    steps++;
  }
  assert.strictEqual(steps, 2, `修复次数必须被限死在预算内（实测 ${steps} 次）`);
});

test('接线守卫：StreamView 的加渲必须走预算，且预算只由 onScroll 补充', async () => {
  const { readFileSync } = await import('node:fs');
  const { dirname, join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, '..', 'src', 'ui', 'components', 'StreamView.tsx'), 'utf8');
  assert.match(
    src,
    /repairBudgetRef\.current!\.take\(\)/,
    '空洞修复必须先申请预算（否则 React #185 可复发）',
  );
  // 预算只能由 onScroll 补充
  const onScrollAt = src.indexOf('const onScroll = ');
  assert.ok(onScrollAt > 0, 'onScroll 必须仍在');
  const onScrollBody = src.slice(onScrollAt, onScrollAt + 700);
  assert.match(
    onScrollBody,
    /repairBudgetRef\.current!\.noteScroll\(\)/,
    '预算必须由 onScroll（用户滚动）补充',
  );
});
