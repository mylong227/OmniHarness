// (U1) 共振场统一基板：合并 燧-3 共振寻址 + 宇宙网。断言：
// ① 近重复事实黏附去重（不新建条目，单一频谱索引）；② 超 Bekenstein 容量界则 RG 坍缩且存储不膨胀；
// ③ 纤维召回返回共振簇成员；④ resonate 文本探针返回共振事实；⑤ tune 守恒（facts 与 base 一致）。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { LongTermMemoryPort, MemoryFact } from '../../src/ports/memory/longTermMemory.js';
import { ResonantFieldEngine } from '../../src/adapters/memory/resonantFieldEngine.js';
import { eigenSpectrum } from '../../src/util/eigenspectrum.js';

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
function fact(text: string): MemoryFact {
  return {
    id: `f${seq++}`,
    text,
    importance: 3,
    createdAt: new Date().toISOString(),
    sessionId: 's1',
    source: 'tool',
  };
}

const A = '调度 任务 夜间 坤';

test('① 黏附去重：近重复事实只存 1 条（单一频谱索引）', () => {
  const mem = new MemLongTermMemory();
  const engine = new ResonantFieldEngine(mem, { adhesionThreshold: 0.6 });
  engine.remember(fact(A));
  engine.remember(fact(A));
  engine.remember(fact(A));
  assert.strictEqual(mem.count, 1, '三次近重复应只存 1 条（黏附去重）');
  // resonate 文本探针应召回该事实。
  const hits = engine.resonateByText(A, 3);
  assert.strictEqual(hits.length, 1);
  assert.ok(hits[0]!.score > 0.9);
});

test('② RG 坍缩：超 Bekenstein 容量界则节点坍缩且存储不膨胀', () => {
  const mem = new MemLongTermMemory();
  const engine = new ResonantFieldEngine(mem, { adhesionThreshold: 0.95, bekensteinCap: 4 });
  const distinct = [
    '苹果香蕉西瓜',
    '火车飞机轮船',
    '太阳月亮星星',
    '老虎狮子大象',
    '红色蓝色绿色',
    '北京上海广州',
    '钢琴吉他鼓',
    '雨伞帽子围巾',
    '山河流海洋',
    '书笔纸墨水',
  ];
  for (let i = 0; i < 10; i++) engine.remember(fact(distinct[i]!));
  assert.strictEqual(mem.count, 10, '初始 10 节点 10 条');
  const rep = engine.consolidate();
  assert.ok(rep.nodes <= 4, `簇数应受容量界约束（${rep.nodes} ≤ 4）`);
  assert.strictEqual(rep.nodes, 4, '坍缩后应恰好剩 4 簇');
  assert.strictEqual(mem.count, 4, '存储应坍缩而非膨胀（10→4）');
});

test('③ 纤维召回：发射探针返回共振簇成员', () => {
  const mem = new MemLongTermMemory();
  const engine = new ResonantFieldEngine(mem, { adhesionThreshold: 0.2 });
  engine.remember(fact(A));
  const hits = engine.fiber(eigenSpectrum(A, 257), 5);
  assert.ok(hits.length >= 1, '纤维应返回共振簇成员');
  assert.ok(
    hits.every((f) => f.text === A),
    '纤维成员应属同簇',
  );
});

test('④ resonate 文本探针：返回共振度最高的事实', () => {
  const mem = new MemLongTermMemory();
  const engine = new ResonantFieldEngine(mem, { adhesionThreshold: 0.95 });
  const near = '调度 任务 夜间 坤 排班'; // 与 A 近义
  engine.remember(fact(A));
  engine.remember(fact('完全无关的量子比特纠缠态'));
  const hits = engine.resonateByText(near, 2);
  assert.strictEqual(hits[0]!.fact.text, A, '最接近的应是 A');
});

test('⑤ tune 守恒：facts 与 base 一致', () => {
  const mem = new MemLongTermMemory();
  const engine = new ResonantFieldEngine(mem, { adhesionThreshold: 0.95 });
  engine.remember(fact('alpha beta gamma'));
  engine.remember(fact('delta epsilon zeta'));
  const t = engine.tune();
  assert.strictEqual(t.facts, 2);
  assert.strictEqual(t.clusters, 2);
});
