// DialogService 契约测试（D4）：替代 window.confirm / window.prompt 的 Promise 语义。
// 零 DOM 依赖：仅验证「请求 → 结算」的状态机与 fail-closed 行为。
//
// 为什么单独测服务而不是测组件：决策闸门的正确性在于「用户没选之前不许继续」，
// 这是 Promise 语义 + 状态机的事，与渲染无关；组件只负责把状态画出来。

import assert from 'node:assert/strict';
import test from 'node:test';

const { DialogService } = await import('../dist/core/DialogService.js');

test('未绑定宿主时 confirm 抛错（fail-closed，绝不静默当作取消）', () => {
  const svc = new DialogService();
  assert.throws(() => svc.confirm('丢弃改动？'), /尚未绑定宿主/);
  assert.throws(() => svc.prompt('目标？'), /尚未绑定宿主/);
});

test('confirm：submit 结算为 true，cancel 结算为 false', async () => {
  const svc = new DialogService();
  const seen = [];
  svc.bind((s) => seen.push(s));

  const p1 = svc.confirm('丢弃改动？', { title: '丢弃', confirmLabel: '丢弃', danger: true });
  assert.strictEqual(svc.pending, true);
  const req = seen[seen.length - 1].request;
  assert.strictEqual(req.kind, 'confirm');
  assert.strictEqual(req.title, '丢弃');
  assert.strictEqual(req.confirmLabel, '丢弃');
  assert.strictEqual(req.cancelLabel, '取消');
  assert.strictEqual(req.danger, true);
  svc.submit('');
  assert.strictEqual(await p1, true);
  assert.strictEqual(svc.pending, false);

  const p2 = svc.confirm('再确认一次？');
  svc.cancel();
  assert.strictEqual(await p2, false);
});

test('prompt：submit 回传输入串（含空串），cancel 回传 null', async () => {
  const svc = new DialogService();
  const seen = [];
  svc.bind((s) => seen.push(s));

  const p1 = svc.prompt('设置目标：', '旧目标');
  const req = seen[seen.length - 1].request;
  assert.strictEqual(req.kind, 'prompt');
  assert.strictEqual(req.initial, '旧目标', 'prompt 必须带初始值');
  svc.submit('新目标');
  assert.strictEqual(await p1, '新目标');

  // 空串是合法输入（「留空清除」语义），不能被当成取消
  const p2 = svc.prompt('设置目标：', 'x');
  svc.submit('');
  assert.strictEqual(await p2, '');

  const p3 = svc.prompt('设置目标：', 'x');
  svc.cancel();
  assert.strictEqual(await p3, null);
});

test('confirm 的 prompt 初始值恒为空串（不泄漏输入态）', () => {
  const svc = new DialogService();
  let last = null;
  svc.bind((s) => (last = s));
  void svc.confirm('确认？');
  assert.strictEqual(last.request.initial, '');
});

test('前一个未结算请求按取消收口，避免 Promise 永久悬挂', async () => {
  const svc = new DialogService();
  svc.bind(() => {});
  const first = svc.confirm('第一个');
  const second = svc.confirm('第二个');
  assert.strictEqual(await first, false, '被顶掉的请求应结算为取消');
  svc.cancel();
  assert.strictEqual(await second, false);
});

test('cancel / submit 在无待决请求时是安全的空操作', () => {
  const svc = new DialogService();
  svc.bind(() => {});
  assert.doesNotThrow(() => svc.cancel());
  assert.doesNotThrow(() => svc.submit('x'));
});
