/**
 * 向量时钟判据：tick / merge / before-after-concurrent / 往返。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { VectorClock } from '../../src/util/concurrency/vectorClock.ts';

test('① tick 只推进本节点；before/after 可判', () => {
  const a = new VectorClock().tick('A');
  const a2 = a.tick('A');
  assert.strictEqual(a.compare(a2), 'before');
  assert.strictEqual(a2.compare(a), 'after');
  assert.strictEqual(a.compare(a), 'equal');
});

test('② 并发事件：A 与 B 各自 tick 后互相 concurrent', () => {
  const seed = new VectorClock().tick('A').tick('B');
  const a = seed.tick('A');
  const b = seed.tick('B');
  assert.strictEqual(a.compare(b), 'concurrent');
  assert.strictEqual(b.compare(a), 'concurrent');
});

test('③ merge 后因果收敛，且幂等/交换', () => {
  const base = new VectorClock().tick('A').tick('B');
  const a = base.tick('A');
  const b = base.tick('B');
  const ab = a.merge(b);
  const ba = b.merge(a);
  assert.deepStrictEqual(ab.toJSON(), ba.toJSON(), 'merge 必须交换');
  assert.deepStrictEqual(ab.merge(b).toJSON(), ab.toJSON(), 'merge 必须幂等');
  assert.strictEqual(ab.compare(a), 'after');
  assert.strictEqual(ab.compare(b), 'after');
});

test('④ JSON 往返与非法计数拒绝', () => {
  const clock = new VectorClock({ A: 2, B: 1 });
  assert.deepStrictEqual(VectorClock.fromJSON(clock.toJSON()).toJSON(), { A: 2, B: 1 });
  assert.throws(() => new VectorClock({ A: -1 }), /非负整数/);
  assert.throws(() => new VectorClock({ A: 1.5 }), /非负整数/);
  assert.throws(() => VectorClock.fromJSON('x'), /对象/);
});

test('⑤ 三节点偏序：A→B 与 B→C 的传递性', () => {
  const v1 = new VectorClock({ A: 1 });
  const v2 = v1.tick('B');
  const v3 = v2.tick('C');
  assert.strictEqual(v1.compare(v3), 'before');
  assert.strictEqual(v3.compare(v1), 'after');
});
