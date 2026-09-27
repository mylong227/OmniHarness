// 虚拟化「锚定自愈」算术门禁（零 DOM、确定性）：滚动空洞修复的核心算术。
//
// ## 缺陷形态（2026-09-27 用户报「滚到该区域没有任何显示」）
//
// 中栏虚拟化用 `BlockHeightIndex`（实测 ∪ 估算）算 padTop/padBottom 与滚动定位，而**浏览器的 scrollTop
// 是真实 DOM 高度**。两者不一致（估算 88px vs 长回复几百 px、簇展开折叠后的陈旧高、忙/闲分组换掉块
// 含义）时错位累积 ⇒ 跳转滚动（拖滚动条）后视口正落在占位区，**一个块都看不到**。
// 实测：真实会话（152 事件 / 81 块）跳转滚动每轮 2–4 处空白，最差一档覆盖率 **0%**（DOM 里仍有 23 块）；
// 接上本算术（`StreamWindow.anchorDelta` + StreamView 的校正）后两轮均为 0 处。
//
// ## 为什么这里只测算术
//
// 端到端复现需要「加载真实会话 + 跳转滚动」这一整套条件（合成流实测**不复现**：批量推事件与逐条推
// 在测量时序上不同，估算/实测失配量也不同）。故：**算术在单测里钉死**（本文件），
// 端到端只留一条「不得出现整屏占位」的烟雾检测（`streamScrollCoverage.test.mjs`，诚实标注其边界）。
//
// 直跑：node --test web/test/streamWindowAnchor.test.mjs（需先 npm run web:build）。
import assert from 'node:assert/strict';
import test from 'node:test';

const { StreamWindow } = await import('../dist/ui/models/StreamWindow.js');

test('一致时校正量为 0（DOM 偏移 == 模型偏移）', () => {
  const viewportTop = 100;
  const scrollTop = 500;
  const anchors = [{ index: 5, top: 50, bottom: 150 }];
  // 模型说第 5 块在 450px 处 → 与 DOM 推出的 500 + (50 - 100) = 450 一致 ⇒ 无需校正。
  const delta = StreamWindow.anchorDelta(viewportTop, scrollTop, anchors, (i) => (i === 5 ? 450 : 0));
  assert.strictEqual(delta, 0);
});

test('视口落进空洞时把内容拉回（校正量 = 模型偏移 − DOM 偏移）', () => {
  const viewportTop = 100;
  const scrollTop = 500;
  // 锚块 DOM 顶边在视口上方 50px（已经滚过去 50px），DOM 推出的块顶偏移 = 450；
  // 而模型认为它在 900 ⇒ 真实内容比模型「靠上」，需要把 scrollTop 再加 450 才对齐。
  const anchors = [{ index: 5, top: 50, bottom: 150 }];
  const delta = StreamWindow.anchorDelta(viewportTop, scrollTop, anchors, (i) => (i === 5 ? 900 : 0));
  assert.strictEqual(delta, 450);
});

test('优先取「跨过视口顶」的块，而不是顶边最近的那块', () => {
  const viewportTop = 100;
  const scrollTop = 500;
  const anchors = [
    { index: 2, top: 20, bottom: 40 }, // 顶边更近（|20−100|=80），但完全在视口上方
    { index: 3, top: 90, bottom: 200 }, // 跨过视口顶 ⇒ 应当被选为锚
  ];
  const delta = StreamWindow.anchorDelta(viewportTop, scrollTop, anchors, (i) => (i === 3 ? 700 : 0));
  // DOM 推出的第 3 块顶偏移 = 500 + (90 − 100) = 490 ⇒ delta = 700 − 490 = 210
  assert.strictEqual(delta, 210);
});

test('没有跨过视口顶的块时，退回「顶边最接近视口顶」的那块', () => {
  const viewportTop = 100;
  const scrollTop = 500;
  const anchors = [
    { index: 2, top: 20, bottom: 40 },
    { index: 3, top: 300, bottom: 400 },
  ];
  const delta = StreamWindow.anchorDelta(viewportTop, scrollTop, anchors, (i) => (i === 2 ? 1000 : 0));
  // 选 index=2：DOM 顶偏移 = 500 + (20 − 100) = 420 ⇒ delta = 1000 − 420 = 580
  assert.strictEqual(delta, 580);
});

test('锚点为空（窗口内一个块都没渲染）时校正量为 0（不猜测）', () => {
  assert.strictEqual(StreamWindow.anchorDelta(100, 500, [], () => 0), 0);
});

test('负向校正同样成立（模型偏移小于 DOM 偏移 ⇒ 往回拉）', () => {
  const delta = StreamWindow.anchorDelta(100, 900, [{ index: 1, top: 150, bottom: 250 }], () => 300);
  // DOM 顶偏移 = 900 + (150 − 100) = 950 ⇒ delta = 300 − 950 = −650
  assert.strictEqual(delta, -650);
});

test('接线守卫：StreamView 必须真的用上锚定校正（防被摘掉）', async () => {
  const { readFileSync } = await import('node:fs');
  const { dirname, join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, '..', 'src', 'ui', 'components', 'StreamView.tsx'), 'utf8');
  assert.match(
    src,
    /StreamWindow\.anchorDelta\(/,
    'StreamView 必须调用 StreamWindow.anchorDelta（否则「滚动空洞」会复发）',
  );
});

// ============================================================================
// 第二段：**动 scrollTop 的闸**（2026-09-27 用户报「滚动会被回退回原本的位置」）
//
// 校正不能无条件套用：用户拖到从没渲染过的区域时，该区域上方 overscan 块本轮才第一次被测量
// （估算 88px vs 真实几百 px），差值一次性算进校正量 ⇒ 位置被推回原来那一带。
// 真机实测（真服务 + 真会话 sess_mujn1om2_1，1280×800，跳转滚动）：
//   加闸前：请求 943→2489（回退 1546px）、3772→4614（842）、1650→1983（333）
//   加闸后：同序列**逐档 0px**；而「视口几乎没内容」的两档仍被修（覆盖 8%→100%、36%→100%）。
// ============================================================================

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
  // 两块与视口完全重叠（真实场景不会同时发生，但口径必须夹到 1，不得 >1）
  const overlap = [
    { index: 0, top: 90, bottom: 710 },
    { index: 1, top: 90, bottom: 710 },
  ];
  assert.strictEqual(StreamWindow.viewportCoverage(100, 600, overlap), 1);
});

test('覆盖率：视口高 ≤ 0（尚未测到）时按「无需修复」处理', () => {
  assert.strictEqual(StreamWindow.viewportCoverage(100, 0, [{ index: 0, top: 0, bottom: 10 }]), 1);
});

test('是否需要修空洞：内容看得见时**一律不动**用户的滚动位置', () => {
  // 视口被完整覆盖 ⇒ 不修（这正是「滚动被回退」的判据：那三档当时覆盖率都是 100%）
  assert.strictEqual(
    StreamWindow.needsAnchorRepair(100, 600, [{ index: 0, top: 100, bottom: 700 }]),
    false,
  );
  // 只覆盖一半以上：仍不修（避免为边角缺几像素去动滚动条）
  assert.strictEqual(
    StreamWindow.needsAnchorRepair(100, 600, [{ index: 0, top: 100, bottom: 460 }]),
    false,
  );
});

test('是否需要修空洞：视口基本没内容（空洞）时必须修', () => {
  // 实测那一档：覆盖率 8%（43/581）⇒ 必须修
  assert.strictEqual(
    StreamWindow.needsAnchorRepair(0, 581, [{ index: 0, top: -538, bottom: -495 }]),
    true,
  );
  // 一点内容都没有：更要修
  assert.strictEqual(
    StreamWindow.needsAnchorRepair(0, 581, [{ index: 0, top: -3000, bottom: -2500 }]),
    true,
  );
  // 锚点为空（窗口内一个块都没有）：不猜，直接返回 false
  assert.strictEqual(StreamWindow.needsAnchorRepair(0, 581, []), false);
});

test('接线守卫：校正必须**在闸内**执行（无条件套用即视为回归）', async () => {
  const { readFileSync } = await import('node:fs');
  const { dirname, join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, '..', 'src', 'ui', 'components', 'StreamView.tsx'), 'utf8');
  assert.match(
    src,
    /Math\.abs\(delta\) > 1 &&\s*StreamWindow\.needsAnchorRepair\(/,
    '写回 scrollTop 必须同时满足 needsAnchorRepair（否则「滚动被回退」会复发）',
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
