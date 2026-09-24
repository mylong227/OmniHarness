import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PendingRequests } from '../../src/util/pendingRequests.js';

/** 造一个可断言的收尾通道（记录收到的 resolve/reject）。 */
function channels<T>(): {
  handlers: { resolve: (v: T) => void; reject: (e: Error) => void };
  resolved: T[];
  rejected: Error[];
} {
  const resolved: T[] = [];
  const rejected: Error[] = [];
  return {
    handlers: {
      resolve: (v: T): void => void resolved.push(v),
      reject: (e: Error): void => void rejected.push(e),
    },
    resolved,
    rejected,
  };
}

test('PendingRequests: 登记后结算 —— 兑现一次且条目移出（重复结算幂等）', () => {
  const table = new PendingRequests<number, string>();
  const c = channels<string>();
  table.register(1, c.handlers);
  assert.strictEqual(table.size(), 1);
  assert.strictEqual(table.settle(1, 'ok'), true);
  assert.deepEqual(c.resolved, ['ok']);
  assert.strictEqual(table.size(), 0);
  // 重复结算（同一响应到达两次 / 超时与响应竞争）不得二次兑现
  assert.strictEqual(table.settle(1, 'again'), false);
  assert.deepEqual(c.resolved, ['ok']);
});

test('PendingRequests: 未知 key 的结算/失败均返回 false（不抛错）', () => {
  const table = new PendingRequests<number, string>();
  assert.strictEqual(table.settle(42, 'x'), false);
  assert.strictEqual(table.fail(42, new Error('nope')), false);
  assert.strictEqual(table.take(42), undefined);
});

test('PendingRequests: 失败走 reject 通道；只有 resolve 的站点失败时仅清理', () => {
  const table = new PendingRequests<string, number>();
  const c = channels<number>();
  table.register('a', c.handlers);
  assert.strictEqual(table.fail('a', new Error('boom')), true);
  assert.strictEqual(c.rejected.length, 1);
  assert.strictEqual(c.rejected[0]?.message, 'boom');
  assert.strictEqual(table.size(), 0);

  // 无 reject 通道（httpBridgeTransport 的形态）：失败只移出，不抛错、不误兑现
  let resolved = 0;
  table.register('b', { resolve: () => void (resolved += 1) });
  assert.strictEqual(table.fail('b', new Error('boom')), true);
  assert.strictEqual(resolved, 0);
  assert.strictEqual(table.size(), 0);
});

test('PendingRequests: 超时把处理器交给调用方决定收尾（reject 或 resolve 均可）', async () => {
  const table = new PendingRequests<string, string>();
  const timedOut: string[] = [];
  table.register(
    'reject-on-timeout',
    { resolve: () => assert.fail('不应兑现'), reject: (e) => timedOut.push(e.message) },
    { ms: 5, onTimeout: (h) => h.reject?.(new Error('超时了')) },
  );
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(timedOut, ['超时了']);
  assert.strictEqual(table.size(), 0);

  // 审批的形态：超时**兑现**为 deny（fail-closed 而非报错）
  const decisions: string[] = [];
  table.register(
    'deny-on-timeout',
    { resolve: (v) => decisions.push(v) },
    {
      ms: 5,
      onTimeout: (h) => h.resolve('deny'),
    },
  );
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(decisions, ['deny']);
  assert.strictEqual(table.size(), 0);
});

test('PendingRequests: 已结算的条目其超时定时器被清掉，不会二次收尾', async () => {
  const table = new PendingRequests<number, string>();
  const c = channels<string>();
  const fired: string[] = [];
  table.register(7, c.handlers, { ms: 5, onTimeout: () => fired.push('late') });
  assert.strictEqual(table.settle(7, 'first'), true);
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(fired, [], '结算后定时器必须已清理（否则会出现双收尾）');
  assert.deepEqual(c.resolved, ['first']);
});

test('PendingRequests: take 命中后由调用方自行分支（按回包的 error 字段）', () => {
  const table = new PendingRequests<number, unknown>();
  const c = channels<unknown>();
  table.register(3, c.handlers);
  const handlers = table.take(3);
  assert.ok(handlers !== undefined);
  handlers.reject?.(new Error('远端错误'));
  assert.deepEqual(
    c.rejected.map((e) => e.message),
    ['远端错误'],
  );
  assert.strictEqual(table.size(), 0);
});

test('PendingRequests: failAll 一次性拒绝全部并返回条数（传输/进程断开路径）', () => {
  const table = new PendingRequests<number, string>();
  const a = channels<string>();
  const b = channels<string>();
  const onlyResolve = channels<string>();
  table.register(1, a.handlers);
  table.register(2, b.handlers);
  table.register(3, { resolve: onlyResolve.handlers.resolve });
  assert.strictEqual(table.size(), 3);
  const count = table.failAll(new Error('连接已关闭'));
  assert.strictEqual(count, 3);
  assert.strictEqual(a.rejected.length, 1);
  assert.strictEqual(b.rejected.length, 1);
  assert.strictEqual(onlyResolve.rejected.length, 0, '无 reject 通道的条目不得被误兑现');
  assert.strictEqual(a.resolved.length + b.resolved.length, 0);
  assert.strictEqual(table.size(), 0);
  // 再调一次：已无在途条目
  assert.strictEqual(table.failAll(new Error('再来一次')), 0);
});

test('PendingRequests: settleAll 全部兑现同一值并返回条数（断连一律 deny）', () => {
  const table = new PendingRequests<string, string>();
  const a = channels<string>();
  const b = channels<string>();
  table.register('apr-1', a.handlers);
  table.register('apr-2', b.handlers);
  assert.strictEqual(table.settleAll('deny'), 2);
  assert.deepEqual(a.resolved, ['deny']);
  assert.deepEqual(b.resolved, ['deny']);
  assert.strictEqual(table.size(), 0);
  assert.strictEqual(table.settleAll('deny'), 0);
});

test('PendingRequests: 同一 key 重复登记覆盖旧条目（与各站点原 Map.set 语义一致）', () => {
  const table = new PendingRequests<number, string>();
  const first = channels<string>();
  const second = channels<string>();
  table.register(1, first.handlers);
  table.register(1, second.handlers);
  assert.strictEqual(table.size(), 1);
  assert.strictEqual(table.settle(1, 'second'), true);
  assert.deepEqual(second.resolved, ['second']);
  assert.deepEqual(first.resolved, []);
});
