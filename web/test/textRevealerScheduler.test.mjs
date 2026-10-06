// 渐进揭示器的调度契约：**注入的调度器必须以裸函数调用**。
//
// ## 为什么有这条判据（2026-10-06 真机崩溃）
//
// 用户报「打开会话 ⇒ 界面渲染出错 / Illegal invocation / at AssistantCard」。根因不在组件，
// 而在 `TextRevealer.tick()` 里的 `this.schedule(fn, ms)`：那是一次**以揭示器实例为 receiver 的
// 方法调用**。`AssistantCard` 此前写 `schedule ?? setTimeout`，于是浏览器宿主函数 `setTimeout`
// 被当方法调用 —— WebIDL 校验 receiver 后直接抛 `TypeError: Illegal invocation`（真 Chrome 实测：
// `obj.schedule = setTimeout; obj.schedule(fn, 0)` ⇒ Illegal invocation；裸调 `t(fn, 0)` ⇒ 正常）。
// 触发条件是「回合进行中（busy）+ 该助手消息未走过流式（animate）+ 正文 > 240 字」⇒ 第一帧即崩，
// 整个界面落进渲染错误边界。
//
// node 里的 `setTimeout` 不做 receiver 校验，所以**只断言"不抛错"抓不到这个 bug**（会假绿）。
// 本判据改为断言**调用时的 receiver**：正常应是 `undefined`（ESM 严格模式下的裸调用），
// 若哪天又变回 `this.schedule(...)`，receiver 就成了实例 ⇒ 判据红（与浏览器同一条失效条件）。
import assert from 'node:assert/strict';
import test from 'node:test';

const { TextRevealer } = await import('../dist/ui/models/TextRevealer.js');

/** 长文本（超过 SHORT_TEXT=240 才走动画路径）。 */
const LONG = 'x'.repeat(500);

test('注入的调度器必须被裸调用（receiver 不得是揭示器实例）', () => {
  const receivers = [];
  /** 记录 receiver 的调度器桩（非箭头函数，才能观察 this）。 */
  function spy(fn, ms) {
    receivers.push(this);
    fn();
    return 0;
  }
  const r = new TextRevealer(() => undefined, spy);
  r.start(LONG, true);
  assert.ok(receivers.length >= 1, '长文本 + animate 必须真的排一次帧');
  assert.deepStrictEqual(
    receivers.map(() => 'undefined'),
    receivers.map((x) => String(x)),
    `调度器被当方法调用了（receiver=${receivers[0]}）⇒ 浏览器会抛 Illegal invocation`,
  );
  r.stop();
});

test('直接把浏览器宿主函数传进来也必须安全（老写法 `schedule ?? setTimeout` 的形态）', () => {
  const globalThisSetTimeout = setTimeout; // 与浏览器里传 window.setTimeout 同形
  const r = new TextRevealer(() => undefined, globalThisSetTimeout);
  r.start(LONG, true);
  assert.strictEqual(r.running, true, '应已排帧');
  r.stop();
  assert.strictEqual(r.running, false, 'stop 后不得再排帧');
});

test('缺省调度器可用，且短文本/不播放动画时一次到位不进定时器', () => {
  const seen = [];
  const r = new TextRevealer((s) => seen.push(s));
  r.start('short', true);
  assert.deepStrictEqual(seen, ['short'], '短文本（≤240）必须一次到位');
  assert.strictEqual(r.running, false, '短文本不得排帧');
  r.start(LONG, false);
  assert.strictEqual(seen[seen.length - 1], LONG, 'animate=false 时直接全量');
  assert.strictEqual(r.running, false, 'animate=false 时不得排帧');
  r.stop();
});
