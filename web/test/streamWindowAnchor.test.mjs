// 虚拟化「空洞修复」算术门禁（零 DOM、确定性）。
//
// ## 缺陷形态（2026-09-27 用户报「滚到该区域没有任何显示」）
//
// 中栏虚拟化用 `BlockHeightIndex`（实测 ∪ 估算）算 padTop/padBottom 与滚动定位，而**浏览器的
// scrollTop 是真实 DOM 高度**。两者不一致时（估算 88px vs 长回复几百 px）跳转滚动后视口会落进
// 占位区 ⇒ 一屏空白。真机实测（真会话 sess_mujn1om2_1，跳转滚动 12 档）：**8% / 36%** 两档。
//
// ## 修法的三次演进（前两次都被用户实测打回，留档防回退）
//
// ① **写回 scrollTop**（把锚块的真实偏移对齐到模型偏移）：修好了空洞，但拖到没渲染过的区域时会
//    **把用户推回原位**（实测 943→2489，回退 1546px）。
// ② **加闸**（只有覆盖 < 50% 才写回）：用户仍报「滚动依旧回退、无法滚到顶」——近顶部那两档本就是
//    8% / 36%，一往上拖就被推回去（实测 236→569、463→1411）。
// ③ **本版：不改位置，只多渲染**（两侧各多渲染若干块）。用户的滚动位置全程不动 ⇒ 这两类症状在
//    设计上不可能发生。故 `anchorDelta`（写回用的校正量）已**删除**，只保留「覆盖率」与「要不要修」
//    两个纯判据。
//
// ## ④ 2026-10-07：把「滚动预算」闸也删掉（同一次删掉 `models/ScrollRepairBudget.ts`）
//
// 预算（每次用户滚动补 2 次、`take()` 消耗）本意是给「修复会 setState」一个可证上界。真机实测
// （用户报「会话流滚动时出现大面积空白」）它反成了病灶：**测量引发的布局效应也会消耗预算**，长滚动
// 序列里预算耗尽后该修的洞就修不了（13 档抽样里两档覆盖率只剩 46% / 59%）。终止性改由 StreamView
// 里的**结构性单次迁移**保证：`holeBoost` 只做 0 → HOLE_BOOST_BLOCKS 一次迁移，置位后守卫短路、
// 同值 setState bail，且本路径**从不写 scrollTop** ⇒ `render → effect → setState` 循环在结构上
// 不可自我续期（原 #185 来自已删除的「写回」变体）。下方接线守卫钉死这一契约。
//
// 直跑：node --test web/test/streamWindowAnchor.test.mjs（需先 npm run web:build）。
import assert from 'node:assert/strict';
import test from 'node:test';

const { StreamWindow } = await import('../dist/ui/models/StreamWindow.js');

test('覆盖率：完整覆盖为 1，锚点为空为 0', () => {
  const anchors = [{ index: 0, top: 100, bottom: 700 }];
  assert.strictEqual(StreamWindow.viewportCoverage(100, 600, anchors), 1);
  assert.strictEqual(StreamWindow.viewportCoverage(100, 600, []), 0);
});

test('覆盖率：只算与视口相交的部分，且不超过 1', () => {
  // 视口 [100, 700]：块 A 只覆盖上半 [100,400]，块 B 覆盖 [600,900] ⇒ (300 + 100) / 600
  const anchors = [
    { index: 0, top: 0, bottom: 400 },
    { index: 1, top: 600, bottom: 900 },
  ];
  assert.ok(Math.abs(StreamWindow.viewportCoverage(100, 600, anchors) - 400 / 600) < 1e-9);
  const overlap = [
    { index: 0, top: 90, bottom: 710 },
    { index: 1, top: 90, bottom: 710 },
  ];
  assert.strictEqual(StreamWindow.viewportCoverage(100, 600, overlap), 1);
});

test('覆盖率：视口高 ≤ 0（尚未测到）时按「无需修复」处理', () => {
  assert.strictEqual(StreamWindow.viewportCoverage(100, 0, [{ index: 0, top: 0, bottom: 10 }]), 1);
});

test('是否需要修空洞：**几乎填满**时不修，留半屏空白时必须修（阈值 0.9 的口径）', () => {
  // 完整覆盖 ⇒ 不修
  assert.strictEqual(
    StreamWindow.needsAnchorRepair(100, 600, [{ index: 0, top: 100, bottom: 700 }]),
    false,
  );
  // 95% 覆盖（视口 [100,700]，块覆盖 [100,670]）⇒ 只差一条边，不修
  assert.strictEqual(
    StreamWindow.needsAnchorRepair(100, 600, [{ index: 0, top: 100, bottom: 670 }]),
    false,
  );
  // 60% 覆盖（块覆盖 [100,460]）⇒ 剩下 240px 是占位（半屏空白），必须修：
  // 修复方式是**多渲染**（不动用户的滚动位置），所以阈值取得保守。
  assert.strictEqual(
    StreamWindow.needsAnchorRepair(100, 600, [{ index: 0, top: 100, bottom: 460 }]),
    true,
  );
  // 85% 覆盖（块覆盖 [100,610]）⇒ 仍在阈值之下，修
  assert.strictEqual(
    StreamWindow.needsAnchorRepair(100, 600, [{ index: 0, top: 100, bottom: 610 }]),
    true,
  );
});

test('是否需要修空洞：真机实测那两档必须修（8% / 36%）', () => {
  // 8%：视口 [0,581]，块只覆盖其上方 43px
  assert.strictEqual(
    StreamWindow.needsAnchorRepair(0, 581, [{ index: 0, top: -538, bottom: -495 }]),
    true,
  );
  // 36%：视口 [0,581]，块覆盖 [0,209]
  assert.strictEqual(
    StreamWindow.needsAnchorRepair(0, 581, [{ index: 0, top: 0, bottom: 209 }]),
    true,
  );
  assert.strictEqual(StreamWindow.needsAnchorRepair(0, 581, []), false);
});

test('接线守卫：修复**不得**再写回 scrollTop（两类用户报障的共同根源）', async () => {
  const { readFileSync } = await import('node:fs');
  const { dirname, join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, '..', 'src', 'ui', 'components', 'StreamView.tsx'), 'utf8');
  assert.doesNotMatch(
    src,
    /el\.scrollTop\s*=\s*el\.scrollTop\s*\+/,
    '不得再以「写回 scrollTop」的方式修空洞（会把用户推回原位；上一版即此）',
  );
  assert.doesNotMatch(
    src,
    /StreamWindow\.anchorDelta\(/,
    'anchorDelta 已删除（其唯一用途是写回），不得复活',
  );
});

test('接线守卫：空洞修复必须是「多渲染」且终止性为结构性单次迁移（防 React #185）', async () => {
  const { readFileSync } = await import('node:fs');
  const { dirname, join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, '..', 'src', 'ui', 'components', 'StreamView.tsx'), 'utf8');
  const setterAt = src.indexOf('setHoleBoost(HOLE_BOOST_BLOCKS)');
  assert.ok(setterAt > 0, '空洞修复必须走「加渲」（setHoleBoost）');
  const ifBefore = src.lastIndexOf('if (', setterAt);
  const condition = src.slice(ifBefore, setterAt);
  assert.match(
    condition,
    /StreamWindow\.needsAnchorRepair\(/,
    '加渲必须由「视口基本没内容」触发，不得无条件加渲',
  );
  // 2026-10-07 移除「滚动预算」闸（预算每滚动只补 2 次，测量引发的布局效应会把它耗尽，
  // 真机实测长滚动序列里该修的洞修不了——用户报「滚动出现大面积空白」）。终止性改由
  // 结构性守卫保证：holeBoost 只做 0→N 的单次迁移，已置位即短路 + 同值 bail，
  // render→effect→setState 循环在结构上不可自我续期。
  assert.match(
    condition,
    /holeBoost\s*<\s*HOLE_BOOST_BLOCKS/,
    '加渲必须受「单次迁移」守卫（已加渲后不得再次 setState）',
  );
  assert.doesNotMatch(
    src,
    /repairBudgetRef/,
    '预算闸已删（见上），不得复活半吊子的旧机制',
  );
});

test('接线守卫：中栏必须关掉浏览器自带的滚动锚定（overflow-anchor:none）', async () => {
  const { readFileSync } = await import('node:fs');
  const { dirname, join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const here = dirname(fileURLToPath(import.meta.url));
  const css = readFileSync(join(here, '..', 'styles', 'chat.css'), 'utf8');
  const rule = /\n\.stream\s*\{([^}]*)\}/.exec(css);
  assert.ok(rule !== null, 'chat.css 必须仍有 .stream 规则');
  assert.match(
    rule[1],
    /overflow-anchor:\s*none/,
    '中栏必须 overflow-anchor:none：浏览器自带锚定会自行改 scrollTop（实测 +440 / +527px 回退）',
  );
});
