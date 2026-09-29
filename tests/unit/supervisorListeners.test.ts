// 监督内核：模式转移订阅者上限与去重（审计 §30 Gap ⑤）单元测试。
// 覆盖：onTransition 重复订阅只保留一份；超过 MAX_LISTENERS(64) 淘汰最旧订阅者，避免无界增长。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SupervisorKernel } from '../../src/supervisor/supervisorKernel.js';

/**
 * 订阅者上限：与 src/supervisor/supervisorKernel.ts 的模块级 const MAX_LISTENERS 对齐。
 * 该值为模块级常量（非类静态字段），故此处显式引用其已知值 64。
 */
const MAX_LISTENERS = 64;

test('onTransition：订阅者超过上限后淘汰最旧（无界增长防御）', () => {
  const cap = MAX_LISTENERS;
  assert.ok(cap > 0, '上限应为正数');
  const s = new SupervisorKernel({ hazardousTools: ['shell'], lockAfterConsecutiveFailures: 100 });
  const called: number[] = [];
  const listeners: Array<(from: string, to: string) => void> = [];
  for (let i = 0; i < cap + 6; i += 1) {
    const idx = i;
    const cb = (): void => {
      called.push(idx);
    };
    listeners.push(cb);
    s.onTransition(cb);
  }
  // 触发一次转移（shell 失败 → safe），仅当前在册的订阅者（最旧 6 个已被淘汰）应收到。
  s.report('shell', 'failure');
  assert.strictEqual(s.mode(), 'safe');
  // 共订阅 cap+6 个，最旧 6 个被淘汰，应只通知最后 cap 个（索引 6..cap+5）。
  assert.deepStrictEqual(
    called,
    Array.from({ length: cap }, (_, k) => 6 + k),
    `应只通知最后 ${cap} 个订阅者（最旧 6 个被淘汰）`,
  );
  // 最旧 6 个（0..5）确实未收到广播。
  for (let i = 0; i < 6; i += 1) {
    assert.ok(!called.includes(i), `最旧订阅者 ${i} 应被淘汰，未收到广播`);
  }
});

test('onTransition：同一回调重复订阅只保留一份（去重）', () => {
  const s = new SupervisorKernel({ hazardousTools: ['shell'], lockAfterConsecutiveFailures: 100 });
  let count = 0;
  const cb = (): void => {
    count += 1;
  };
  s.onTransition(cb);
  s.onTransition(cb); // 重复订阅应被去重
  s.report('shell', 'failure'); // 仅一次转移
  assert.strictEqual(count, 1, '重复订阅的同一回调只应收到一次广播');
});
