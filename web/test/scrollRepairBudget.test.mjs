// 滚动校正预算门禁（零 DOM、确定性）：给「写回 scrollTop」一个**结构上可证的**上界。
//
// ## 为什么需要（2026-09-27 用户截图的 React #185「Maximum update depth exceeded」）
//
// `StreamView` 的锚定校正写在 `useLayoutEffect` 里，而写回 scrollTop 会改变虚拟窗口 ⇒ 布局效应
// 再次运行 ⇒ 只要校正量始终 > 1px，就形成 `render → layoutEffect → setState(scrollTop) → render`
// 的**同步**循环（React 抛 #185；页面主线程被占满）。几何上「本该收敛」不足以保证（实测有会话状态
// 不收敛），故必须有预算：**预算只在用户自己滚动时补充**，我们自己写回所触发的 scroll 事件不补充
// ⇒ 循环无法自我续期。
//
// 直跑：node --test web/test/scrollRepairBudget.test.mjs（需先 npm run web:build）。
import assert from 'node:assert/strict';
import test from 'node:test';

const { ScrollRepairBudget } = await import('../dist/ui/models/ScrollRepairBudget.js');

test('默认预算：允许 2 次写回，第 3 次拒绝', () => {
  const b = new ScrollRepairBudget();
  assert.strictEqual(b.take(100), true);
  assert.strictEqual(b.take(200), true);
  assert.strictEqual(b.take(300), false, '预算耗尽后必须拒绝（否则可无限写回）');
  assert.strictEqual(b.remainingCount(), 0);
});

test('用户自己滚动 ⇒ 补充预算', () => {
  const b = new ScrollRepairBudget(2);
  b.take(500);
  b.take(700);
  assert.strictEqual(b.take(900), false);
  b.noteScroll(1200); // 用户滚到别处（与我们写回的值差 > 1px）
  assert.strictEqual(b.take(1200), true, '用户滚动后应重新获得预算');
});

test('我们自己写回触发的 scroll 事件**不得**补充预算（循环防线的关键）', () => {
  const b = new ScrollRepairBudget(2);
  const target = 842;
  assert.strictEqual(b.take(target), true);
  b.noteScroll(target); // 浏览器为我们的写回补发的 scroll 事件（同值，含 1px 容差）
  b.noteScroll(target + 1);
  assert.strictEqual(b.remainingCount(), 1, '自写回的滚动事件不得把预算补回上限');
});

test('取整容差：±1px 之内仍视为「我们自己写回的」', () => {
  const b = new ScrollRepairBudget(1);
  assert.strictEqual(b.take(1000), true);
  b.noteScroll(999.6);
  assert.strictEqual(b.remainingCount(), 0);
});

test('max <= 0 ⇒ 彻底禁用校正（不允许任何写回）', () => {
  const b = new ScrollRepairBudget(0);
  assert.strictEqual(b.take(10), false);
  b.noteScroll(10);
  assert.strictEqual(b.take(10), false);
});

test('死循环模拟：render→take→自写回 scroll 事件→render … 必须在 max+1 步内终止', () => {
  const b = new ScrollRepairBudget(2);
  let scrollTop = 0;
  let steps = 0;
  // 模拟「几何永不收敛」的最坏情形：每轮都要求校正，而每次写回都由浏览器补发一个同值 scroll 事件。
  for (let i = 0; i < 1000; i++) {
    const target = scrollTop + 500; // 永远差 500px（不收敛）
    if (!b.take(target)) break;
    scrollTop = target;
    b.noteScroll(scrollTop);
    steps++;
  }
  assert.strictEqual(steps, 2, `写回次数必须被限死在预算内（实测 ${steps} 次）`);
});

test('接线守卫：StreamView 的写回必须走预算，且预算只由 onScroll 补充', async () => {
  const { readFileSync } = await import('node:fs');
  const { dirname, join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, '..', 'src', 'ui', 'components', 'StreamView.tsx'), 'utf8');
  // 定位真正的写回语句，把它所属 if 的条件切出来看（只看「附近有 take」会被 `take(x) || true` 骗过）。
  const writeAt = src.indexOf('el.scrollTop = el.scrollTop + delta;');
  assert.ok(writeAt > 0, '必须仍有写回 scrollTop 的语句（否则空洞修复被整段删除，需人工确认）');
  const ifBefore = src.lastIndexOf('if (', writeAt);
  assert.ok(ifBefore > 0, '写回语句必须处在某个 if 条件内');
  const condition = src.slice(ifBefore, writeAt);
  assert.match(
    condition,
    /StreamWindow\.needsAnchorRepair\(/,
    '写回必须仍受「只在空洞时修」的闸约束',
  );
  assert.match(
    condition,
    /repairBudgetRef\.current!\.take\(/,
    '写回必须先申请预算（否则 React #185 可复发）',
  );
  assert.doesNotMatch(
    condition,
    /\|\|\s*true|\?\?\s*true/,
    '不得用 `|| true` 之类短路把预算抹掉（那是「有预算但不生效」）',
  );
  assert.match(
    src,
    /repairBudgetRef\.current!\.noteScroll\(/,
    '预算必须由 onScroll 补充（否则无法区分「用户滚动」与「我们自己写回」）',
  );
});
