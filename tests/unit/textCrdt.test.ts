/**
 * 文本 CRDT（RGA）判据：并发插入/删除合并后收敛、幂等、确定性物化。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { TextCrdt } from '../../src/util/textCrdt.ts';

test('① 同位置并发插入：合并后两端物化一致（顺序由副本 id 决定）', () => {
  const a = new TextCrdt('A');
  const b = new TextCrdt('B');
  const opsA = a.insert(0, 'x');
  const opsB = b.insert(0, 'y');
  for (const op of opsB) a.apply(op);
  for (const op of opsA) b.apply(op);
  assert.strictEqual(a.toString(), 'xy');
  assert.strictEqual(b.toString(), 'xy');
});

test('② 并发删除：墓碑合并后两边都不再显示', () => {
  const a = new TextCrdt('A');
  const b = new TextCrdt('B');
  const seed = a.insert(0, 'abc');
  for (const op of seed) b.apply(op);
  const del = a.delete(1, 1);
  for (const op of del) b.apply(op);
  assert.strictEqual(a.toString(), 'ac');
  assert.strictEqual(b.toString(), 'ac');
  assert.strictEqual(a.length(), 2);
});

test('③ 离线副本 merge：插入 + 删除混合后收敛', () => {
  const a = new TextCrdt('A');
  const b = new TextCrdt('B');
  a.insert(0, 'hello');
  b.merge(a);
  a.delete(1, 2); // el
  b.insert(5, '!');
  const snapshotA = new TextCrdt('A2');
  for (const node of a.snapshot()) snapshotA.apply({ kind: 'insert', node });
  b.merge(snapshotA);
  a.merge(b);
  assert.strictEqual(a.toString(), b.toString());
  assert.match(a.toString(), /^h/);
  assert.ok(a.toString().endsWith('!'));
});

test('④ 合并幂等：同一份快照 merge 两次不改变结果', () => {
  const a = new TextCrdt('A');
  a.insert(0, 'abc');
  const b = new TextCrdt('B');
  b.merge(a);
  const first = b.toString();
  b.merge(a);
  b.merge(a);
  assert.strictEqual(b.toString(), first);
});

test('⑤ 同父节点并发插入：按副本 id 确定序，不依赖到达顺序', () => {
  const a = new TextCrdt('A');
  const b = new TextCrdt('B');
  a.insert(0, 'a');
  // 让 b 也以同一父（null）插入
  b.insert(0, 'b');
  const a2 = new TextCrdt('A2');
  a2.apply({ kind: 'insert', node: a.snapshot()[0]! });
  const b2 = new TextCrdt('B2');
  b2.apply({ kind: 'insert', node: b.snapshot()[0]! });
  const first = new TextCrdt('X');
  first.apply({ kind: 'insert', node: a.snapshot()[0]! });
  first.apply({ kind: 'insert', node: b.snapshot()[0]! });
  const second = new TextCrdt('Y');
  second.apply({ kind: 'insert', node: b.snapshot()[0]! });
  second.apply({ kind: 'insert', node: a.snapshot()[0]! });
  assert.strictEqual(first.toString(), second.toString());
});
