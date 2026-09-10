// (E, I-P1-3) QEC 记忆：二维奇偶症状编码 + 单点 corrupt 定位纠正 + 多点 fail-closed。
// 断言：① 干净事实 verify=ok；② 单点 corrupt 可定位并纠正复原；③ 多点 corrupt 标记
// uncorrectable（绝不静默接受损坏）；④ repairAll 聚合统计。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { LongTermMemoryPort, MemoryFact } from '../../src/ports/longTermMemory.js';
import { QECEncoder } from '../../src/adapters/memory/qec.js';

class MemLongTermMemory implements LongTermMemoryPort {
  public readonly name = 'mem';
  private facts: MemoryFact[] = [];
  public remember(fact: MemoryFact): void {
    this.facts.push(fact);
  }
  public recall(): readonly MemoryFact[] {
    return this.facts;
  }
  public all(): readonly MemoryFact[] {
    return this.facts;
  }
  public get count(): number {
    return this.facts.length;
  }
  public get(id: string): MemoryFact | undefined {
    return this.facts.find((f) => f.id === id);
  }
  public update(id: string, patch: { importance?: number; text?: string }): boolean {
    const f = this.facts.find((x) => x.id === id) as
      { importance?: number; text?: string } | undefined;
    if (f === undefined) return false;
    if (patch.importance !== undefined) f.importance = patch.importance;
    if (patch.text !== undefined) f.text = patch.text;
    return true;
  }
  public delete(id: string): boolean {
    const i = this.facts.findIndex((f) => f.id === id);
    if (i < 0) return false;
    this.facts.splice(i, 1);
    return true;
  }
}

let seq = 0;
function fact(id: string, text: string): MemoryFact {
  return {
    id,
    text,
    importance: 3,
    createdAt: new Date().toISOString(),
    sessionId: 's1',
    source: 'tool',
  };
}

test('① 干净事实 verify=ok；单点 corrupt 可定位并纠正复原', () => {
  const mem = new MemLongTermMemory();
  const enc = new QECEncoder(mem, { cols: 8 });
  mem.remember(fact('f1', 'hello world'));
  enc.encode('f1');
  assert.strictEqual(enc.verify('f1'), 'ok', '干净事实应为 ok');

  // 单点 corrupt：'o' → 'x'。
  mem.update('f1', { text: 'hellx world' });
  assert.strictEqual(enc.verify('f1'), 'corrected', '单点损坏应可纠正');
  const status = enc.repair('f1');
  assert.strictEqual(status, 'corrected');
  assert.strictEqual(mem.get('f1')!.text, 'hello world', '修复后应复原原文');
});

test('② 多点 corrupt 标记 uncorrectable（fail-closed，不静默接受）', () => {
  const mem = new MemLongTermMemory();
  const enc = new QECEncoder(mem, { cols: 8 });
  mem.remember(fact('f2', 'abcdefgh'));
  enc.encode('f2');
  // 两点损坏：首、末字符翻转。
  mem.update('f2', { text: 'xbcdEfgh' });
  assert.strictEqual(enc.verify('f2'), 'uncorrectable', '多点损坏无法唯一定位');
  const status = enc.repair('f2');
  assert.strictEqual(status, 'uncorrectable', 'repair 不得静默改写');
  assert.strictEqual(mem.get('f2')!.text, 'xbcdEfgh', '损坏内容应保持原样（不擅自改）');
});

test('③ repairAll 聚合统计（纠正单点 + 标记多点）', () => {
  const mem = new MemLongTermMemory();
  const enc = new QECEncoder(mem, { cols: 8 });
  mem.remember(fact('a', 'hello world'));
  mem.remember(fact('b', 'abcdefgh'));
  enc.encode('a');
  enc.encode('b');
  mem.update('a', { text: 'hellx world' }); // 单点
  mem.update('b', { text: 'xbcdEfgh' }); // 多点
  const rep = enc.repairAll();
  assert.strictEqual(rep.checked, 2);
  assert.strictEqual(rep.corrected, 1, '应纠正单点损坏的 a');
  assert.strictEqual(rep.uncorrectable, 1, '应标记多点损坏的 b');
  assert.strictEqual(mem.get('a')!.text, 'hello world', 'a 应被复原');
  assert.strictEqual(mem.get('b')!.text, 'xbcdEfgh', 'b 应保持损坏（fail-closed）');
});
