// (D) 热方程记忆重加权 / 退火调度：把长期记忆建模为"事实图"，以燧-3 频率域共振度为边权
// 构建耦合矩阵，跑离散热方程扩散（簇内共识、簇间隔离）+ 温度退火调度（高温激进重排、
// 低温冻结）+ 衰减遗忘（孤立事实退向地板）。断言：
//   ① 双共振簇：簇内重要性趋同（共识）、簇间间隙保留（隔离）、温度单调下降；
//   ② 孤立事实：衰减项下重要性随时间下降（自然遗忘）；
//   ③ 阈值剪枝：无共振的两条事实互不扩散（间隙保留）；
//   ④ 空记忆：anneal 零漂移、零事实、不抛错；
//   ⑤ SparkController 集成：含 annealer 时 cycle 报告 anneal 维度；无燧能力时 ran=false；
//   ⑥ 主循环接线：仅开 memoryAnnealing 即构造 spark+annealer，cycle 实际重加权记忆。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { LongTermMemoryPort, MemoryFact } from '../../src/ports/longTermMemory.js';
import { HeatEquationAnnealer } from '../../src/adapters/memory/heatAnnealer.js';
import { SparkController } from '../../src/spark/sparkController.js';
import { ConfigFactory } from '../../src/config/omniharnessConfig.js';
import { MemoryStorage } from '../../src/adapters/storage/memoryStorage.js';
import { AutoApproval } from '../../src/adapters/approval/autoApproval.js';
import { PassthroughSandbox } from '../../src/adapters/sandbox/passthroughSandbox.js';
import { SilentEventPort } from '../../src/adapters/event/silentEventPort.js';
import { ScriptedModel } from '../../src/eval/scriptedModel.js';

/** 测试用内存长期记忆桩（仅满足端口契约，importance 可变）。 */
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
  public update(id: string, patch: { importance?: number }): boolean {
    const f = this.facts.find((x) => x.id === id);
    if (f === undefined) return false;
    if (patch.importance !== undefined) (f as { importance: number }).importance = patch.importance;
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
function fact(text: string, importance = 3): MemoryFact {
  return {
    id: `f${seq++}`,
    text,
    importance,
    createdAt: new Date().toISOString(),
    sessionId: 's1',
    source: 'tool',
  };
}

// 两个主题，字符集互不重叠（杜绝跨主题共享字符，确保共振正交、cross 共振≈0）。
const TOPIC_A = '调度 任务 夜间 坤';
const TOPIC_B = '预算 报表 戌期 乾';

function tmpWs(): string {
  return mkdtempSync(join(tmpdir(), 'omni-heat-'));
}

test('① 双共振簇：簇内共识、簇间隔离、温度单调下降', () => {
  const mem = new MemLongTermMemory();
  // 簇 A：重要性不均，验证收敛到局部共识。
  mem.remember(fact(TOPIC_A, 5));
  mem.remember(fact(TOPIC_A, 3));
  mem.remember(fact(TOPIC_A, 4));
  // 簇 B：全部地板 1，验证不被簇 A 拉高（隔离）。
  mem.remember(fact(TOPIC_B, 1));
  mem.remember(fact(TOPIC_B, 1));
  mem.remember(fact(TOPIC_B, 1));

  const annealer = new HeatEquationAnnealer(mem, { coupling: 0.2, decay: 0.02 });
  const T0 = annealer.temperature;
  let prevT = T0;
  for (let s = 0; s < 10; s++) {
    const r = annealer.anneal();
    assert.ok(r.temperature < prevT, `温度应单调下降（step ${r.step}）`);
    prevT = r.temperature;
  }

  const a = mem
    .all()
    .filter((f) => f.text === TOPIC_A)
    .map((f) => f.importance);
  const b = mem
    .all()
    .filter((f) => f.text === TOPIC_B)
    .map((f) => f.importance);
  const aMean = a.reduce((x, y) => x + y, 0) / a.length;
  const bMean = b.reduce((x, y) => x + y, 0) / b.length;
  const aSpread = Math.max(...a) - Math.min(...a);

  assert.ok(aSpread < 1.0, `簇 A 内应趋同（spread=${aSpread.toFixed(3)} < 1）`);
  assert.ok(Math.abs(bMean - 1) < 1e-6, '簇 B 应停留在地板 1（未被簇 A 拉高）');
  assert.ok(aMean - bMean > 2, `簇间间隙应保留（A≈${aMean.toFixed(2)} vs B≈${bMean.toFixed(2)}）`);
  assert.ok(annealer.temperature < T0, '最终温度应低于初始温度（已退火冻结）');
});

test('② 孤立事实：衰减项下重要性随时间下降（自然遗忘）', () => {
  const mem = new MemLongTermMemory();
  mem.remember(fact(TOPIC_A, 5)); // 单条、无共振邻居
  const annealer = new HeatEquationAnnealer(mem, { decay: 0.2, coolingRate: 1000 });
  const imps: number[] = [5];
  for (let s = 0; s < 3; s++) {
    annealer.anneal();
    imps.push(mem.all()[0]!.importance);
  }
  assert.ok(imps[1]! < imps[0]!, `第 1 步应下降（${imps[0]} → ${imps[1]}）`);
  assert.ok(imps[3]! < imps[1]!, `应持续下降（${imps[1]} → ${imps[3]}）`);
  // 不跌破地板。
  assert.ok(imps[3]! >= 1, '不应跌破地板 1');
});

test('③ 阈值剪枝：无共振的两条事实互不扩散（间隙保留）', () => {
  const mem = new MemLongTermMemory();
  mem.remember(fact(TOPIC_A, 5)); // 高重要、与 B 不共振
  mem.remember(fact(TOPIC_B, 1)); // 低重要
  const annealer = new HeatEquationAnnealer(mem, { resonanceThreshold: 0.35 });
  const before = mem.all()[0]!.importance - mem.all()[1]!.importance;
  annealer.anneal();
  const after = mem.all()[0]!.importance - mem.all()[1]!.importance;
  // B 无邻居、衰减对地板无效 → 保持 1；A 仅衰减、不被 B 拉高 → 间隙基本不变。
  assert.ok(Math.abs(after - before) < 0.3, `无共振不应扩散，间隙应保留（${before} → ${after}）`);
});

test('④ 空记忆：anneal 零漂移、零事实、不抛错', () => {
  const mem = new MemLongTermMemory();
  const annealer = new HeatEquationAnnealer(mem);
  const T0 = annealer.temperature; // = 初始温度（默认 1.0）
  const r = annealer.anneal();
  assert.strictEqual(r.facts, 0);
  assert.strictEqual(r.drift, 0);
  assert.ok(annealer.temperature < T0, '空记忆退火后温度仍应按调度下降');
});

test('⑤ SparkController 集成：含 annealer 时 cycle 报告 anneal 维度', async () => {
  const mem = new MemLongTermMemory();
  mem.remember(fact(TOPIC_A, 5));
  mem.remember(fact(TOPIC_B, 1));
  const annealer = new HeatEquationAnnealer(mem, { decay: 0.1 });

  // 含 annealer → ran=true、报告 anneal。
  const withA = new SparkController({ annealer, autoRun: true });
  const repA = await withA.cycle();
  assert.strictEqual(repA.ran, true);
  assert.ok(repA.anneal !== undefined, '应含 anneal 维度');
  assert.ok(repA.anneal!.drift > 0, '本步应有重要性漂移');

  // 空控制器（无任何燧能力）→ ran=false。
  const none = new SparkController({});
  const repN = await none.cycle();
  assert.strictEqual(repN.ran, false);
  assert.strictEqual(repN.anneal, undefined);
});

test('⑥ 主循环接线：仅开 memoryAnnealing 即构造 spark+annealer，cycle 实际重加权记忆', () => {
  const mem = new MemLongTermMemory();
  mem.remember(fact(TOPIC_A, 5));
  mem.remember(fact(TOPIC_B, 1));
  const before = mem.all().map((f) => f.importance);

  const config = ConfigFactory.build({
    workspaceRoot: tmpWs(),
    maxSteps: 8,
    model: new ScriptedModel([], '退火完成'),
    storage: new MemoryStorage(),
    approvals: new AutoApproval(),
    sandbox: new PassthroughSandbox(),
    events: new SilentEventPort(),
    longTermMemory: mem,
    memoryAnnealing: { enabled: true, decay: 0.1 },
    sparkAutoRun: true,
  });

  // 仅开 memoryAnnealing（无 resonance/vortex）→ 仍应构造 spark 与 annealer。
  assert.ok(config.spark instanceof SparkController, '仅开退火应仍构造 SparkController');
  assert.ok(config.spark!.autoRun, 'sparkAutoRun 应开启');
  assert.ok(config.annealer instanceof HeatEquationAnnealer, '应注入 HeatEquationAnnealer');

  // 跑一轮 cycle，断言记忆重要性真被重加权（非空转）。
  return config.spark!.cycle().then((r) => {
    assert.ok(r.anneal !== undefined, '主循环 cycle 应含 anneal 维度');
    const after = mem.all().map((f) => f.importance);
    const drift = after.reduce((acc, v, i) => acc + Math.abs(v - before[i]!), 0);
    assert.ok(drift > 0, '主循环退火应实际重加权长期记忆重要性');
  });
});
