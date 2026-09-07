import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LongTermMemoryPort, MemoryFact } from '../../src/ports/longTermMemory.js';
import { ResonantMemoryEngine } from '../../src/adapters/memory/resonantMemory.js';
import {
  eigenSpectrum,
  spectrumFromValues,
  resonance,
  tokenizeChunks,
  type Spectrum,
} from '../../src/util/eigenspectrum.js';

const BINS = 257;

/** 测试用内存长期记忆桩（仅满足端口契约，recall 用子串匹配占位）。 */
class MemLongTermMemory implements LongTermMemoryPort {
  readonly name = 'mem';
  private facts: MemoryFact[] = [];
  remember(fact: MemoryFact): void {
    this.facts.push(fact);
  }
  recall(query: string, k: number): readonly MemoryFact[] {
    return this.facts.filter((f) => f.text.includes(query)).slice(0, k);
  }
  all(): readonly MemoryFact[] {
    return this.facts;
  }
  get count(): number {
    return this.facts.length;
  }
  get(id: string): MemoryFact | undefined {
    return this.facts.find((f) => f.id === id);
  }
  update(): boolean {
    return false;
  }
  delete(): boolean {
    return false;
  }
}

let seq = 0;
function fact(topic: string, text: string): MemoryFact {
  return {
    id: `f${seq++}`,
    text,
    topic,
    importance: 3,
    createdAt: new Date().toISOString(),
    sessionId: 's1',
    source: 'tool',
  };
}

// 三个主题，字符集互不重叠（含主题专属字，杜绝跨主题共享字符）。
const TOPIC_A = '调度 任务 夜间 坤';
const TOPIC_B = '预算 报表 戌期 乾';
const TOPIC_C = '登录 权限 账艮 艮';
const base = new MemLongTermMemory();
for (let i = 0; i < 3; i++) {
  base.remember(fact('A', TOPIC_A));
  base.remember(fact('B', TOPIC_B));
  base.remember(fact('C', TOPIC_C));
}
const engine = new ResonantMemoryEngine(base, BINS);
const factsA = base.all().filter((f) => f.topic === 'A');

/** 向量基线：字符计数向量（无谐波、无平滑），代表市面主流几何距离寻址。 */
function flatVec(text: string): Spectrum {
  const raw = new Array<number>(BINS).fill(0);
  for (const ch of tokenizeChunks(text)) {
    const idx = ch.charCodeAt(0) % BINS;
    raw[idx] = (raw[idx] ?? 0) + 1;
  }
  return spectrumFromValues(raw, BINS);
}
function cosine(a: Spectrum, b: Spectrum): number {
  return resonance(a, b);
}

test('聚显/SNR：同频探针激发主题 A 全部事实，异频事实共振度≈0', () => {
  const probe = eigenSpectrum(TOPIC_A, BINS);
  const hits = engine.resonate(probe, 9);
  const top3 = hits
    .slice(0, 3)
    .map((h) => h.fact.id)
    .sort();
  const aIds = factsA.map((f) => f.id).sort();
  assert.deepStrictEqual(top3, aIds, 'top-3 应全部是主题 A');
  const aScore = hits.find((h) => h.fact.topic === 'A')!.score;
  const bMax = Math.max(...hits.filter((h) => h.fact.topic === 'B').map((h) => h.score));
  const cMax = Math.max(...hits.filter((h) => h.fact.topic === 'C').map((h) => h.score));
  assert.ok(aScore > 0.9, `主题 A 共振度应高，实得 ${aScore.toFixed(3)}`);
  assert.ok(
    bMax < 0.25 && cMax < 0.25,
    `异频主题应≈0，实得 B=${bMax.toFixed(3)} C=${cMax.toFixed(3)}`,
  );
});

test('频响特性：单峰探针频率偏移 → 共振度按高斯平滑单调衰减（同频即显、异频即散）', () => {
  // 用平滑高斯峰（频率签名）构造事实与探针；旋转峰值位置才体现连续频响。
  const n = BINS;
  const peak = (center: number, sigma = 1): Spectrum => {
    const raw = Array.from({ length: n }, (_, i) =>
      Math.exp(-((i - center) * (i - center)) / (2 * sigma * sigma)),
    );
    return spectrumFromValues(raw, n);
  };
  const B = 40;
  const factSpec = peak(B);
  const probeAt = (r: number): Spectrum => peak((B + r) % n);
  const s0 = resonance(factSpec, probeAt(0));
  const sNear = resonance(factSpec, probeAt(1));
  const sFar = resonance(factSpec, probeAt(8));
  assert.ok(s0 > sNear, `无偏移 ${s0.toFixed(3)} 应 > 近偏移 ${sNear.toFixed(3)}`);
  assert.ok(sNear > sFar, `近偏移 ${sNear.toFixed(3)} 应 > 远偏移 ${sFar.toFixed(3)}`);
  assert.ok(sFar < 0.3 * s0, `远偏移应大幅衰减，实得 ${sFar.toFixed(3)} vs ${s0.toFixed(3)}`);
});

test('vs 向量基线：谐波 bin 探针下，共振代数 > 平面 token 余弦（市面无此寻址维度）', () => {
  // 取主题 A 首字符的谐波 bin 作探针：共振频谱含 2f 谐波能量，平面向量无。
  const charBin = TOPIC_A.charCodeAt(0) % BINS;
  const harmonicBin = (charBin * 2) % BINS;
  const probe = spectrumFromValues(
    Array.from({ length: BINS }, (_, i) => (i === harmonicBin ? 1 : 0)),
    BINS,
  );
  const resonantScore = engine.resonate(probe, 3)[0]!.score;
  const baselineScore = cosine(flatVec(factsA[0]!.text), probe);
  assert.ok(resonantScore > 0.1, `共振应捕获谐波能量，实得 ${resonantScore.toFixed(3)}`);
  assert.ok(
    resonantScore > baselineScore,
    `共振 ${resonantScore.toFixed(3)} 应 > 向量基线 ${baselineScore.toFixed(3)}（几何距离法缺谐波/频响）`,
  );
});
