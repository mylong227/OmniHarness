// 视图挂载状态（**视图代数**）的语义判据：`models/ViewAttachment.ts`。
//
// ## 这一条防的是什么（两处都真机踩过）
//
// ① **默认必须"挂载"**：全新控制器 / 刷新页面 / 深链加载会话都要能继续接收该会话的流式事件。
//    曾经把默认设成"已摘"（`isDetached = true`）⇒ 这些正常路径**静默丢事件**：界面看起来"连上了、
//    但一个字都不来"。这一条把"默认挂载"钉死，谁改回去谁红。
// ② **代数必须每次"挂 / 摘"都前进**：只靠 detached 布尔量判断不出"换了另一条会话"——用户切到
//    别的会话时视图是**挂载**的（要收新会话的流），但旧回合的收尾**仍必须被丢弃**。代数前进后
//    `attach()` 返回的旧值必然不等于当前值，收尾自然出局。
//
// 判据只测模型本身（纯数据，零 DOM、零 React）：不引 dist 的控制器，避免把"接线"与"语义"两件事
// 混在一个用例里——接线的回归判据在 turnControl.test.mjs（真会话 + 真控制器）。
import assert from 'node:assert/strict';
import test from 'node:test';

const { ViewAttachment } = await import('../dist/ui/models/ViewAttachment.js');

test('① 默认挂载：全新实例必须收事件（刷新 / 深链 / 首次挂载都不能丢）', () => {
  const view = new ViewAttachment();
  assert.equal(view.detached, false, '全新实例默认必须是"挂载"：否则正常路径会静默丢事件');
});

test('② 新建会话 ⇒ 摘下；迟到事件被挡住', () => {
  const view = new ViewAttachment();
  const epoch = view.attach();
  view.detach(); // 用户点「+ 新建」
  assert.equal(view.detached, true, '摘之后必须能看出已摘（流式回调据此丢弃迟到事件）');
  assert.notEqual(view.epoch(), epoch, '摘之后代数必须前进：旧回合的收尾据此出局');
});

test('③ 加载会话 ⇒ 重新挂上（刷新 / 点会话后仍能收它的流）', () => {
  const view = new ViewAttachment();
  view.detach();
  view.attach(); // loadThread
  assert.equal(view.detached, false, '加载会话后必须回到"挂载"：否则该会话的流全被丢掉');
});

test('④ 换视图（不经过"新建"）也必须让旧回合出局：每次 attach 都开新的一代', () => {
  const view = new ViewAttachment();
  const epochOfOldTurn = view.attach(); // 回合 A 发出
  const epochAfterSwitch = view.attach(); // 用户切到另一条会话（loadThread 也是 attach）
  assert.notEqual(
    epochAfterSwitch,
    epochOfOldTurn,
    '切会话后 `epoch() !== 旧代数` 必须成立，否则旧回合的收尾会把新视图拽回去',
  );
  assert.equal(view.epoch(), epochAfterSwitch, 'epoch() 返回当前代数（收尾就是与它比对）');
});

test('⑤ 代数只增不减：多次摘挂后旧代数永不"复活"', () => {
  const view = new ViewAttachment();
  const seen = new Set();
  for (let i = 0; i < 6; i += 1) {
    const e = view.attach();
    assert.equal(seen.has(e), false, `代数 ${e} 重复出现：旧回合可能被误判为"还属于当前视图"`);
    seen.add(e);
    view.detach();
  }
});
