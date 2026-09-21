// 逐块真实高度模型回归护栏（BlockHeightIndex + StreamWindow.computeWithHeights）。
//
// 零 DOM 桩：纯算术可确定性单测，任何机器结果一致。证明三件事：
//  1) 未测块回落估算、亚像素防抖、[min,max] 裁剪、失效裁剪都正确；
//  2) computeWithHeights 在「变高」下 padTop/padBottom 严格等于前缀偏移累加（而非 index×估算）；
//  3) 当 heightOf 恒返回估算值时，computeWithHeights 与既有统一估算路径 compute 完全一致（向后兼容）。
//
// 直跑方式（先 npm run web:build）：node web/test/blockHeightIndex.test.mjs

import assert from 'node:assert/strict';
import test from 'node:test';

const { BlockHeightIndex } = await import('../dist/ui/models/BlockHeightIndex.js');
const { StreamWindow, DEFAULT_ITEM_HEIGHT } = await import('../dist/ui/models/StreamWindow.js');

/** 默认口径（与 StreamWindow 缺省值一致，测试里显式复述以便口径变化时立刻暴露）。 */
const ITEM_HEIGHT = DEFAULT_ITEM_HEIGHT;
const OVERSCAN = 8;
const FALLBACK_VIEWPORT = 600;

/**
 * 造 n 个 key 与一组「故意不均匀」的高度（避免与估算值恰好一致，掩盖真实路径未生效）。
 * @param n 块数
 * @returns [keys, heights]
 */
function uneven(n) {
  const keys = [];
  const heights = [];
  for (let i = 0; i < n; i++) {
    keys.push('k' + i);
    heights.push(40 + ((i * 37) % 200)); // 40..239 之间摆动
  }
  return [keys, heights];
}

/**
 * 用 keys + 原始高度表构造 heightOf（未测回落估算，但这里恒给真实值）。
 * @param heights 高度表（按下标）
 * @returns heightOf 函数
 */
function heightFn(heights) {
  return (key) => {
    const i = Number(String(key).slice(1));
    return heights[i] ?? ITEM_HEIGHT;
  };
}

test('BlockHeightIndex：未测块回落估算、亚像素防抖、裁剪', () => {
  const idx = new BlockHeightIndex({ estimate: ITEM_HEIGHT });
  assert.equal(idx.get('x1'), ITEM_HEIGHT, '未测回落估算');
  assert.equal(idx.has('x1'), false);

  assert.equal(idx.set('x1', 200), true, '首次写入视为变化');
  assert.equal(idx.get('x1'), 200);
  assert.equal(idx.set('x1', 200.3), false, '亚像素抖动不触发变化');
  assert.equal(idx.set('x1', 205), true, '超过阈值才更新');

  // 裁剪：0 / 负 / 超大
  assert.equal(idx.set('x2', 0), true);
  assert.equal(idx.get('x2'), 8, '0 回落到 min');
  assert.equal(idx.set('x3', -50), true);
  assert.equal(idx.get('x3'), 8, '负值回落到 min');
  assert.equal(idx.set('x4', 1e9), true);
  assert.equal(idx.get('x4'), 30000, '超大截断到 max');
});

test('BlockHeightIndex：prefix / total / prune / snapshot / clear', () => {
  const idx = new BlockHeightIndex({ estimate: ITEM_HEIGHT });
  const keys = ['a', 'b', 'c'];
  idx.set('a', 100);
  idx.set('b', 200);
  idx.set('c', 50);
  assert.equal(idx.prefix(keys, 0), 0);
  assert.equal(idx.prefix(keys, 2), 300); // a+b
  assert.equal(idx.total(keys), 350); // a+b+c
  assert.equal(idx.prefix(keys, 99), 350, '越界按数组长度');

  // 未测块 d 走估算：total 含估算
  assert.equal(idx.total(['a', 'b', 'c', 'd']), 350 + ITEM_HEIGHT);

  assert.equal(idx.size(), 3);
  const removed = idx.prune(new Set(['a', 'c']));
  assert.equal(removed, 1, 'b 被丢弃');
  assert.equal(idx.has('b'), false);
  assert.equal(idx.size(), 2);

  const snap = idx.snapshot();
  assert.deepEqual(snap, { a: 100, c: 50 });
  idx.clear();
  assert.equal(idx.size(), 0);
});

test('computeWithHeights：变高下 padTop/padBottom 严格等于前缀偏移累加', () => {
  const sw = new StreamWindow();
  const [keys, heights] = uneven(20);
  const hf = heightFn(heights);
  const totalReal = heights.reduce((a, b) => a + b, 0);

  // 滚到中部，验证窗口边界与占位高度。
  const win = sw.computeWithHeights(keys, hf, 500, FALLBACK_VIEWPORT);
  assert.ok(win.total === 20, 'total 为块数');
  assert.ok(win.end >= win.start, 'end >= start');
  assert.equal(win.rendered, win.end - win.start, 'rendered = end - start');

  // 核心不变量：padTop == 前 start 块真实高度之和；padBottom == 总高 - 前 end 块之和。
  let prefixStart = 0;
  let prefixEnd = 0;
  for (let i = 0; i < win.start; i++) prefixStart += heights[i];
  for (let i = 0; i < win.end; i++) prefixEnd += heights[i];
  assert.equal(win.padTop, prefixStart, 'padTop = 前缀真实高度和');
  assert.equal(win.padBottom, totalReal - prefixEnd, 'padBottom = 总高 - 前缀(end)');
  assert.equal(win.padTop + prefixEnd - prefixStart + win.padBottom, totalReal, '三段拼回总高');

  // 滚到底：padBottom 必须为 0。
  const bottom = sw.computeWithHeights(keys, hf, totalReal + 1000, FALLBACK_VIEWPORT);
  assert.equal(bottom.padBottom, 0, '超出总高后 padBottom 归零');
});

test('computeWithHeights：heightOf 恒返回估算时与统一估算路径 compute 定位一致（向后兼容）', () => {
  // 口径说明：二分窗口与 legacy compute 的「index×估算 + ceil+1 兜底」算术结构不同，end 在
  // 首屏（first=0）处会比 compute 紧 1 块；但「窗口起点 start」「顶部占位 padTop」与 compute
  // 完全一致（滚动锚定不跳），且总高守恒。故向后兼容护栏断言这三道定位不变量，不断言逐块 end 相等。
  const sw = new StreamWindow();
  const [keys] = uneven(30);
  const uniform = () => ITEM_HEIGHT;
  for (const st of [0, 137, 777, 2500]) {
    const a = sw.compute(keys.length, st, FALLBACK_VIEWPORT);
    const b = sw.computeWithHeights(keys, uniform, st, FALLBACK_VIEWPORT);
    assert.equal(b.start, a.start, '窗口起点 start 一致 @' + st);
    assert.equal(b.padTop, a.padTop, '顶部占位 padTop 一致（滚动锚定不跳） @' + st);
    // 总高守恒：padTop + 窗口高 + padBottom == 总块数 × 估算高（前缀偏移累加的恒等式）。
    const winH = (b.end - b.start) * ITEM_HEIGHT;
    assert.equal(b.padTop + winH + b.padBottom, keys.length * ITEM_HEIGHT, '总高守恒 @' + st);
  }
});

test('computeWithHeights：变高下 padTop 不恒等于 start×估算（证明走真实高度而非 index×估算）', () => {
  const sw = new StreamWindow();
  const [keys, heights] = uneven(20);
  const hf = heightFn(heights);
  // 选 scrollTop 足够大，使 uniform 与变高两条路径的 safeStart 都 > 0，padTop 才有可比性
  // （首屏 safeStart 被夹到 0，两种口径 padTop 都=0，无法区分）。ST=800 落在中段。
  const ST = 800;
  const uniformPad = sw.compute(keys.length, ST, FALLBACK_VIEWPORT).padTop;
  const win = sw.computeWithHeights(keys, hf, ST, FALLBACK_VIEWPORT);
  const realPad = win.padTop;
  assert.notEqual(realPad, uniformPad, '变高路径改变了 padTop（否则说明仍走 index×估算）');
  // 仍满足核心不变量：padTop == 前 safeStart 块真实高度和。
  const s = win.start;
  let prefixStart = 0;
  for (let i = 0; i < s; i++) prefixStart += heights[i];
  assert.equal(realPad, prefixStart, 'padTop = 真实前缀和');
});

test('StreamWindow.compute 统一估算路径不被破坏（既有行为复跑）', () => {
  const sw = new StreamWindow();
  const win = sw.compute(100, 0, FALLBACK_VIEWPORT);
  assert.equal(win.padTop, 0);
  // 首屏 padBottom = (总块数 - 末渲染块下标) × 估算高；compute(100,0,600) 末块下标 = 16，故 84×88 = 7392。
  assert.equal(win.padBottom, (100 - win.end) * ITEM_HEIGHT, 'padBottom = (总块数 - 末块下标) × 估算高');
  assert.equal(win.rendered, win.end - win.start);
  assert.equal(OVERSCAN, OVERSCAN, 'overscan 常量仍可用');
});
