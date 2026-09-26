import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RequestStallGuard } from '../../src/adapters/model/requestStallGuard.js';

/** 等待指定毫秒：守卫的计时断言需要真实时钟（不注入假时钟，避免测不到真实 setTimeout）。 */
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('RequestStallGuard：空闲到点即中止，且标记为超时', async () => {
  const guard = new RequestStallGuard(120);
  assert.strictEqual(guard.signal.aborted, false);
  assert.strictEqual(guard.timedOut, false);
  await wait(260);
  assert.strictEqual(guard.signal.aborted, true);
  assert.strictEqual(guard.timedOut, true, '由空闲计时器触发 ⇒ timedOut 为真（可重试）');
  guard.dispose();
});

test('RequestStallGuard：touch 重置计时（有进展不被误杀）', async () => {
  const guard = new RequestStallGuard(250);
  await wait(150);
  guard.touch();
  await wait(100);
  assert.strictEqual(guard.signal.aborted, false, 'touch 后仅 100ms（< 250ms 阈值）不得中止');
  await wait(250);
  assert.strictEqual(guard.signal.aborted, true, 'touch 后静默超过阈值应中止');
  assert.strictEqual(guard.timedOut, true);
  guard.dispose();
});

test('RequestStallGuard：dispose 后计时器不再触发', async () => {
  const guard = new RequestStallGuard(120);
  guard.dispose();
  await wait(260);
  assert.strictEqual(guard.signal.aborted, false);
  assert.strictEqual(guard.timedOut, false);
});

test('RequestStallGuard：idleMs <= 0 时不武装计时器', async () => {
  const guard = new RequestStallGuard(0);
  await wait(160);
  assert.strictEqual(guard.signal.aborted, false, '关闭态下不得自行中止');
  assert.strictEqual(guard.timedOut, false);
});

test('RequestStallGuard：转发外部取消，且不计为超时', async () => {
  const external = new AbortController();
  const guard = new RequestStallGuard(5_000, external.signal);
  assert.strictEqual(guard.signal.aborted, false);
  external.abort();
  assert.strictEqual(guard.signal.aborted, true, '调用方取消须立即联动');
  assert.strictEqual(guard.timedOut, false, '调用方取消 ⇒ 不可重试，须与超时区分');
  guard.dispose();
});

test('RequestStallGuard：构造时外部信号已中止则立即联动', () => {
  const external = new AbortController();
  external.abort();
  const guard = new RequestStallGuard(5_000, external.signal);
  assert.strictEqual(guard.signal.aborted, true, '预先取消不得被静默吞掉');
  assert.strictEqual(guard.timedOut, false);
  guard.dispose();
});

test('RequestStallGuard：中止后 touch 不再重新武装', async () => {
  const external = new AbortController();
  const guard = new RequestStallGuard(5_000, external.signal);
  external.abort();
  guard.touch();
  await wait(20);
  assert.strictEqual(guard.signal.aborted, true);
  guard.dispose();
});

test('RequestStallGuard：dispose 后不得再中止（泄漏的定时器/监听器不得影响已收尾的请求）', async () => {
  const guard = new RequestStallGuard(120);
  guard.dispose();
  await wait(260);
  assert.strictEqual(guard.signal.aborted, false, 'dispose 之后定时器不得再触发中止');
  assert.strictEqual(guard.timedOut, false);
});

test('RequestStallGuard：长寿命外部信号上不留监听器（复用同一 signal 不得累积闭包）', () => {
  const controller = new AbortController();
  // 模拟会话级取消令牌：同一个 signal 被成百上千次请求复用。
  const counts = { added: 0, removed: 0 };
  const originalAdd = controller.signal.addEventListener.bind(controller.signal);
  const originalRemove = controller.signal.removeEventListener.bind(controller.signal);
  controller.signal.addEventListener = (...args) => {
    counts.added += 1;
    return originalAdd(...args);
  };
  controller.signal.removeEventListener = (...args) => {
    counts.removed += 1;
    return originalRemove(...args);
  };

  for (let i = 0; i < 50; i += 1) {
    const guard = new RequestStallGuard(10_000, controller.signal);
    guard.dispose();
  }
  assert.ok(counts.added > 0, '前置条件：守卫应转发外部信号');
  assert.strictEqual(
    counts.removed,
    counts.added,
    `addEventListener/removeEventListener 必须成对：added=${counts.added} removed=${counts.removed}`,
  );
});

test('RequestStallGuard：dispose 之后外部取消不得再中止已收尾的请求', async () => {
  const controller = new AbortController();
  const guard = new RequestStallGuard(10_000, controller.signal);
  guard.dispose();
  controller.abort();
  await wait(20);
  assert.strictEqual(guard.signal.aborted, false, '转发器已摘除 ⇒ 不再联动中止');
});
