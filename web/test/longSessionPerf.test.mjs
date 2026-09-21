// 长会话性能与稳定性回归护栏（虚拟化 / 流式节流 / 贴底策略）。
//
// 零 DOM 桩：不加载真实 React/ReactDOM，用 hooksStub 的函数组件运行时驱动 StreamView()，
// 对产出的 vnode 树断言「实际渲染的块数」；StreamThrottle 用注入的确定性假时钟驱动，
// 全程无真实计时依赖（不 sleep、不等 rAF），任何机器上结果一致。
//
// 直跑方式（先 npm run web:build）：node web/test/longSessionPerf.test.mjs

import assert from 'node:assert/strict';
import test from 'node:test';
import { createRuntime } from './hooksStub.mjs';

// deps.js 在模块顶层读 window；先种桩再动态 import 编译产物。
const runtime = createRuntime();
runtime.install();

const { StreamView } = await import('../dist/ui/components/StreamView.js');
const { StreamWindow } = await import('../dist/ui/models/StreamWindow.js');
const { StreamThrottle } = await import('../dist/ui/models/StreamThrottle.js');

/** 默认口径（与 StreamWindow 的缺省值一致，测试里显式复述以便口径变化时立刻暴露）。 */
const ITEM_HEIGHT = 88;
const OVERSCAN = 8;
const FALLBACK_VIEWPORT = 600;
/** 兜底可视高度下的渲染块数上界：ceil(600/88)+1 个可视块 + 上下各 8 个 overscan = 24，取 32 留漂移余量。 */
const RENDER_BOUND = 32;

/**
 * 造 n 条「单块」事件（system / assistant 交替：两者都不并入过程簇，1 条 = 1 个可视块）。
 * @param n 条数
 * @returns 事件数组
 */
function makeEvents(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(
      i % 5 === 0
        ? { id: 'a' + i, type: 'assistant', payload: { content: '回复 ' + i } }
        : { id: 's' + i, type: 'system', payload: { content: '事件 ' + i } },
    );
  }
  return out;
}

/**
 * StreamView 的最小必需 props。
 * @param events 事件数组
 * @param extra 追加 / 覆盖的属性
 * @returns 属性对象
 */
function baseProps(events, extra = {}) {
  return {
    events,
    toolResults: {},
    liveInputs: [],
    onEventClick: () => {},
    onSend: () => {},
    model: '',
    reasoning: '',
    permission: '',
    api: {},
    onModelChange: () => {},
    onReasoningChange: () => {},
    onPermissionChange: () => {},
    ...extra,
  };
}

/**
 * 渲染一次 StreamView（清空 hook 槽位，保证与上一个用例互不串味）。
 * @param events 事件数组
 * @param extra 追加属性
 * @returns vnode 树
 */
function renderStream(events, extra = {}) {
  runtime.reset();
  return runtime.render(StreamView, baseProps(events, extra));
}

/** 深度收集满足谓词的节点（能进 map 产生的嵌套数组）。 */
function collect(vnode, pred, out = []) {
  if (Array.isArray(vnode)) {
    for (const k of vnode) collect(k, pred, out);
    return out;
  }
  if (vnode == null || typeof vnode !== 'object') return out;
  if (pred(vnode)) out.push(vnode);
  collect(vnode.children, pred, out);
  return out;
}

/** 统计 vnode 树里的节点总数（字符串 / 数字叶子不计）。 */
function nodeCount(vnode) {
  if (Array.isArray(vnode)) return vnode.reduce((n, k) => n + nodeCount(k), 0);
  if (vnode == null || typeof vnode !== 'object') return 0;
  return 1 + nodeCount(vnode.children);
}

/** 取带 data-virtual 的虚拟化根节点。 */
function virtualRoot(vnode) {
  return collect(vnode, (n) => (n.props ?? {})['data-virtual'] === '1')[0] ?? null;
}

/** 取 role=log 的滚动容器（虚拟化根节点即它）。 */
function logRoot(vnode) {
  return collect(vnode, (n) => (n.props ?? {}).role === 'log')[0] ?? null;
}

/** 取某节点的数值型 data 属性。 */
function dataNum(node, attr) {
  return Number((node.props ?? {})[attr]);
}

/**
 * 构造确定性假时钟：时间只在 advance() 时前进，回调只在到期时触发。
 * @param start 起始时刻（毫秒）
 * @returns 时钟对象（额外提供 advance / pendingTimers 便于断言）
 */
function makeClock(start = 0) {
  let t = start;
  let seq = 1;
  const timers = new Map();
  return {
    now: () => t,
    schedule(cb, delay) {
      const h = seq++;
      timers.set(h, { at: t + delay, cb });
      return h;
    },
    cancel(h) {
      timers.delete(h);
    },
    /**
     * 时钟前进 ms，并按到期时间顺序触发期间所有到期回调。
     * @param ms 前进的毫秒数
     * @returns 无
     */
    advance(ms) {
      const target = t + ms;
      for (;;) {
        let pick = null;
        for (const [h, timer] of timers) {
          if (timer.at <= target && (pick === null || timer.at < pick.timer.at)) {
            pick = { h, timer };
          }
        }
        if (pick === null) break;
        timers.delete(pick.h);
        t = pick.timer.at;
        pick.timer.cb();
      }
      t = target;
    },
    /** 在飞定时器数量。 */
    pendingTimers: () => timers.size,
  };
}

// ---- a) 消息列表虚拟化：渲染块数与总条数脱钩 ----

test('虚拟化：400 条事件只渲染可视窗口，渲染数远小于总条数', () => {
  const vnode = renderStream(makeEvents(400));
  const root = virtualRoot(vnode);
  assert.ok(root, '虚拟化根节点必须带 data-virtual="1"');
  assert.strictEqual(root.props['data-virtual'], '1');
  assert.strictEqual(root.props['data-total-count'], '400', '总条数信号必须是 400');
  assert.strictEqual(root.props['data-event-count'], '400');
  assert.strictEqual(logRoot(vnode), root, '虚拟化根节点即滚动容器（role=log）');

  const rendered = dataNum(root, 'data-rendered-count');
  assert.ok(rendered > 0, '窗口非空');
  assert.ok(rendered <= RENDER_BOUND, `400 条时渲染块数应 ≤ ${RENDER_BOUND}，实测 ${rendered}`);
  assert.ok(rendered * 10 < 400, `渲染块数应远小于 400，实测 ${rendered}`);
  // 事件块节点数 = 窗口块数（未渲染的块根本不产生 DOM）
  const evNodes = collect(vnode, (n) => String((n.props ?? {}).className ?? '').startsWith('ev '));
  assert.strictEqual(evNodes.length, rendered, '实际事件块节点数必须等于 data-rendered-count');
});

test('虚拟化：总条数翻倍（400 → 800）渲染数与节点数都不增长（不成正比）', () => {
  const small = renderStream(makeEvents(400));
  const large = renderStream(makeEvents(800));
  const smallRoot = virtualRoot(small);
  const largeRoot = virtualRoot(large);
  assert.strictEqual(smallRoot.props['data-total-count'], '400');
  assert.strictEqual(largeRoot.props['data-total-count'], '800');

  const rendered400 = dataNum(smallRoot, 'data-rendered-count');
  const rendered800 = dataNum(largeRoot, 'data-rendered-count');
  assert.ok(
    rendered800 <= RENDER_BOUND,
    `800 条时渲染块数应 ≤ ${RENDER_BOUND}，实测 ${rendered800}`,
  );
  assert.strictEqual(rendered800, rendered400, '总条数翻倍不得改变渲染块数');

  const nodes400 = nodeCount(small);
  const nodes800 = nodeCount(large);
  assert.ok(nodes400 < 400, `节点数不得随条数线性增长，400 条实测 ${nodes400}`);
  assert.ok(
    nodes800 <= nodes400 + 4,
    `总条数翻倍后节点数不得增长（仅占位高度变化）：400→${nodes400}，800→${nodes800}`,
  );
});

test('虚拟化：滚动到中段后窗口随 scrollTop 平移，总高仍由占位撑住', () => {
  const props = baseProps(makeEvents(400));
  runtime.reset();
  const first = runtime.render(StreamView, props);
  const before = dataNum(virtualRoot(first), 'data-rendered-count');
  assert.strictEqual(before <= RENDER_BOUND, true);

  // 模拟真实滚动：stub 的 setState 直接写 hook 槽位，重渲染即得新窗口。
  const box = { scrollTop: 20000, scrollHeight: 40000, clientHeight: 600 };
  logRoot(first).props.onScroll({ currentTarget: box });
  const second = runtime.render(StreamView, props);
  const root = virtualRoot(second);
  const after = dataNum(root, 'data-rendered-count');
  // 首屏被列表起点夹住（无上侧 overscan）。computeWithHeights 用二分前缀窗口：首屏可视块数 =
  // ceil(600/88)=7 块（[0,616] 已覆盖 600 视口）+ 8 个下侧 overscan = 15；比 legacy compute 的
  // ceil+1 兜底少 1 块（更紧、不欠渲）。中段（scrollTop=20000）两路径算出同一窗口：219 起点 + 8 上下 overscan = 24。
  assert.strictEqual(before, 15, `首屏渲染块数应为 15（二分窗口比 legacy 紧 1，实测 ${before}`);
  assert.strictEqual(after, 24, `中段渲染块数应为 24，实测 ${after}`);
  assert.ok(after <= RENDER_BOUND, '滚动到任意位置渲染块数都必须有界');

  const pads = collect(second, (n) => (n.props ?? {}).className === 'stream-pad');
  const padTop = pads.map((n) => String((n.props ?? {}).style.height))[0];
  // 中段 scrollTop=20000：起点 = floor(20000/88)-8 = 219，顶部占位 = 219×88，两路径一致（滚动锚定不跳）。
  assert.strictEqual(padTop, 219 * ITEM_HEIGHT + 'px', '顶部占位高度 = 起始块下标 × 估算块高');
  assert.strictEqual(pads.length, 2, '上下各一个占位块');
});

// ---- b) 流式节流：有界刷新 + 收尾逐字节一致 ----

test('StreamThrottle：2000 次 delta 在冻结时钟下只刷新 1 次，flush 后逐字节一致', () => {
  const clock = makeClock();
  const chunks = [];
  const throttle = new StreamThrottle((text) => chunks.push(text), { intervalMs: 50, clock });
  const deltas = [];
  for (let i = 0; i < 2000; i++) {
    const d = 'd' + i + '|';
    deltas.push(d);
    throttle.push(d);
  }

  assert.strictEqual(chunks.length, 1, '首个增量立即刷出（首字不延迟），其后合并等待');
  assert.strictEqual(chunks[0], deltas[0]);
  assert.strictEqual(throttle.pending(), deltas.slice(1).join(''), 'pending 必须等于未刷出的缓冲');
  assert.strictEqual(clock.pendingTimers(), 1, '任意时刻至多一个在飞定时器');

  throttle.flush();
  assert.strictEqual(chunks.length, 2, 'flush 把剩余缓冲一次刷完');
  assert.strictEqual(chunks.join(''), deltas.join(''), '节流后的最终文本必须与逐条拼接逐字节一致');
  assert.strictEqual(throttle.pending(), '');
  assert.strictEqual(clock.pendingTimers(), 0, 'flush 必须取消在飞定时器');

  throttle.dispose();
  throttle.push('迟到');
  throttle.flush();
  assert.strictEqual(chunks.length, 2, 'dispose 后不得再刷（迟到增量不得复活 UI）');
  assert.strictEqual(throttle.pending(), '');
});

test('StreamThrottle：2000 次 delta 跨 2s 推进，刷新次数有界（≤ 42）且文本一致', () => {
  const clock = makeClock(1000);
  const chunks = [];
  const throttle = new StreamThrottle((text) => chunks.push(text), { intervalMs: 50, clock });
  const deltas = [];
  for (let i = 0; i < 2000; i++) {
    const d = 'x' + (i % 10);
    deltas.push(d);
    throttle.push(d);
    clock.advance(1); // 每次增量推进 1ms：2000ms / 50ms = 40 个间隔 + 首个立即刷新
  }
  const tails = ['tail0', 'tail1', 'tail2', 'tail3', 'tail4'];
  for (const t of tails) throttle.push(t);

  assert.ok(chunks.length <= 42, `2000 次 delta 的刷新次数必须有界（≤42），实测 ${chunks.length}`);
  assert.ok(chunks.length >= 30, `节流不应退化成逐条刷新，实测 ${chunks.length}`);
  assert.notStrictEqual(throttle.pending(), '', '收尾仍有未刷内容，必须靠 flush 兜底');

  throttle.flush();
  assert.strictEqual(chunks.join(''), deltas.concat(tails).join(''), 'flush 后逐字节一致');
  assert.strictEqual(clock.pendingTimers(), 0);
});

test('StreamThrottle：空增量 / 空 flush 不产生无意义刷新', () => {
  const clock = makeClock();
  const chunks = [];
  const throttle = new StreamThrottle((text) => chunks.push(text), { intervalMs: 50, clock });
  throttle.push('');
  throttle.flush();
  assert.strictEqual(chunks.length, 0, '空缓冲不得触发刷新');
  assert.strictEqual(clock.pendingTimers(), 0);
});

// ---- c) 贴底策略：用户上滚后不得被强制拉回 ----

test('贴底策略：用户上滚后新增事件不得改变 scrollTop', () => {
  // 用户在距底 400px 处阅读历史：非贴底 ⇒ 新增事件后 scrollTop 原样保留。
  const scrolledUp = { scrollTop: 1200, scrollHeight: 4000, clientHeight: 600 };
  assert.strictEqual(StreamWindow.atBottom(scrolledUp), false);
  const afterAppend = { scrollTop: 1200, scrollHeight: 5200, clientHeight: 600 };
  assert.strictEqual(
    StreamWindow.stickyScrollTop(false, afterAppend),
    1200,
    '上滚后新增事件不得把滚动条拉回底部',
  );

  // 用户在底部：继续贴底到新内容的底。
  assert.strictEqual(
    StreamWindow.atBottom({ scrollTop: 3400, scrollHeight: 4000, clientHeight: 600 }),
    true,
  );
  assert.strictEqual(
    StreamWindow.stickyScrollTop(true, { scrollTop: 3400, scrollHeight: 5200, clientHeight: 600 }),
    4600,
    '处于底部时必须自动贴底',
  );

  // 内容不足一屏 / 距底 4px 容差内均视为底部。
  assert.strictEqual(
    StreamWindow.atBottom({ scrollTop: 0, scrollHeight: 300, clientHeight: 600 }),
    true,
  );
  assert.strictEqual(
    StreamWindow.atBottom({ scrollTop: 3396, scrollHeight: 4000, clientHeight: 600 }),
    true,
  );
  assert.strictEqual(
    StreamWindow.atBottom({ scrollTop: 3300, scrollHeight: 4000, clientHeight: 600 }),
    false,
  );
});

test('贴底策略：滚动容器保留 ref 与 onScroll 接线（虚拟化与锚定的驱动源）', () => {
  const vnode = renderStream(makeEvents(5));
  const root = logRoot(vnode);
  assert.ok(root, '必须存在 role=log 的滚动容器');
  assert.strictEqual(typeof root.props.onScroll, 'function', '滚动必须接线到窗口重算');
  assert.strictEqual(typeof root.props.ref, 'object', '滚动容器的 ref 必须保留');
  assert.ok('current' in root.props.ref, 'ref 必须是 React ref 形状');
  assert.strictEqual(root.props['aria-label'], '对话事件流');
  assert.strictEqual(root.props['aria-live'], 'polite');
});

test('StreamWindow：占位高度维持滚动条总高比例（padTop + 窗口 + padBottom = 总高）', () => {
  const model = new StreamWindow({
    itemHeight: ITEM_HEIGHT,
    overscan: OVERSCAN,
    fallbackViewport: FALLBACK_VIEWPORT,
  });
  const top = model.compute(400, 0, 0);
  assert.strictEqual(top.total, 400);
  assert.strictEqual(top.start, 0);
  assert.strictEqual(top.padTop, 0);
  assert.ok(top.rendered > 0 && top.rendered <= RENDER_BOUND);
  assert.strictEqual(top.padBottom, (400 - top.rendered) * ITEM_HEIGHT);
  assert.strictEqual(
    top.padTop + top.rendered * ITEM_HEIGHT + top.padBottom,
    400 * ITEM_HEIGHT,
    '占位高度必须把总高补回 总块数 × 估算块高（滚动条比例不变）',
  );

  const mid = model.compute(400, 20000, FALLBACK_VIEWPORT);
  assert.strictEqual(mid.start, 219, '起始块 = floor(scrollTop / 块高) - overscan');
  assert.strictEqual(mid.padTop, 219 * ITEM_HEIGHT);
  assert.strictEqual(mid.rendered, mid.end - mid.start);
  assert.ok(mid.rendered <= RENDER_BOUND);

  // 空列表与负滚动量都要安全（不产生负下标 / 负高度）。
  const empty = model.compute(0, 0, 0);
  assert.deepEqual(empty, { start: 0, end: 0, rendered: 0, padTop: 0, padBottom: 0, total: 0 });
  const negative = model.compute(10, -50, -100);
  assert.strictEqual(negative.start, 0);
  assert.strictEqual(negative.padBottom, 0, '总块数不足一屏时底部无占位');
});
