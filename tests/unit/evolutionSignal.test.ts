/**
 * S1（GEE Kernel v1 · ADR-0008）：信号面端到端判据。
 *
 * 蓝图判据（EVOLUTION_ARCH_UPGRADE_2026-10 §4 S1）：
 * - 合成 production 观测行 → 失败签名进挖掘器、成功密度进固化器（端到端）；
 * - **变异**：掐断信号源 ⇒ 提案数与密度增量恒 0；
 * - provenance 非 production 的行**不入信号**（沿遥测纪律）；
 * - 附加：游标不重复出信号 / constrained 映射 / maxBatch 有界 / 无组合 success 行不产信号。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { EvolutionSignalCollector } from '../../src/evolution/evolutionSignalCollector.js';
import { FailurePatternMiner } from '../../src/evolution/failurePatternMiner.js';
import type { FailureRecord } from '../../src/evolution/failurePatternMiner.js';
import { CapabilityCrystallizer } from '../../src/adapters/skill/capabilityCrystallizer.js';
import { SkillRegistry } from '../../src/skill/skillRegistry.js';
import type { Skill } from '../../src/skill/skill.js';
import type {
  RuntimeObservation,
  RuntimeTelemetryInput,
  RuntimeTelemetryPort,
  TelemetryChainReport,
} from '../../src/ports/runtime/runtimeTelemetry.js';
import type { EvolutionSignal } from '../../src/ports/runtime/evolution.js';

/** 固定时间戳（确定性）。 */
const TS = '2026-10-04T00:00:00.000Z';

/**
 * 内存遥测桩：append-only 记录 + 链序号自增（行为对齐 JsonlRuntimeTelemetry 的消费面）。
 */
class MemoryTelemetry implements RuntimeTelemetryPort {
  /** 端口名（契约字段）。 */
  public readonly name = 'memory-telemetry';
  /** 已落盘观测（落盘序 = 链序）。 */
  private readonly rows: RuntimeObservation[] = [];

  /**
   * 落盘一条观测（分配链序号）。
   * @param input 观测输入
   * @returns 链序号
   */
  public record(input: RuntimeTelemetryInput): number | undefined {
    const seq = this.rows.length + 1;
    this.rows.push({
      ...input,
      ts: input.ts ?? TS,
      seq,
      prev: '0'.repeat(64),
      hash: `h${seq}`,
    });
    return seq;
  }

  /**
   * 读取全部观测（落盘序 = 链序）。
   * @returns 观测快照
   */
  public read(): readonly RuntimeObservation[] {
    return [...this.rows];
  }

  /**
   * 链完整性（桩恒完整）。
   * @returns 校验报告
   */
  public verify(): TelemetryChainReport {
    return { ok: true, count: this.rows.length };
  }
}

/**
 * 造一条观测行。
 * @param overrides 覆盖字段
 * @returns 记录输入
 */
function observation(
  overrides: Partial<RuntimeTelemetryInput> & {
    readonly verdict: 'pass' | 'fail' | 'constrained';
  },
): RuntimeTelemetryInput {
  return {
    id: `obs-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'cycle',
    operator: 'heatAnnealer',
    configSnapshot: {},
    metrics: {},
    provenance: 'production',
    ...overrides,
  };
}

/**
 * 把 failure 信号映射为挖掘器记录（Kernel ② 的路由形状预演）。
 * @param signals 信号流
 * @returns 失败记录流
 */
function failureRecordsOf(signals: readonly EvolutionSignal[]): readonly FailureRecord[] {
  return signals
    .filter((s) => s.kind === 'failure')
    .map((s) => s.failure)
    .filter((f): f is NonNullable<typeof f> => f !== undefined);
}

test('S1 端到端（失败链）：production fail 行 → 失败签名进挖掘器 → 高频签名升格提案', () => {
  const tel = new MemoryTelemetry();
  for (let i = 0; i < 3; i++) {
    tel.record(observation({ verdict: 'fail', metrics: { drift: i } }));
  }
  const collector = new EvolutionSignalCollector({ telemetry: tel });
  const signals = collector.collect();
  assert.strictEqual(signals.length, 3, '三条 production fail 行应产出三条失败信号');
  assert.ok(signals.every((s) => s.kind === 'failure'));
  assert.strictEqual(
    signals[0]!.key,
    'telemetry:cycle × heatAnnealer',
    '签名键应与挖掘器聚类口径同构',
  );
  assert.match(signals[0]!.evidence, /verdict=fail/);
  assert.ok(signals[0]!.evidence.includes('drift=0'), '证据应携带指标摘要（确定性）');

  const miner = new FailurePatternMiner(3);
  const { signatures, proposals } = miner.mine(failureRecordsOf(signals));
  assert.strictEqual(signatures.length, 1, '同签名应聚为一类');
  assert.strictEqual(signatures[0]!.count, 3);
  assert.strictEqual(proposals.length, 1, '同签名 ≥3 次应升格为改进提案（信号面真正喂到挖掘器）');
  assert.strictEqual(proposals[0]!.signatureKey, 'telemetry:cycle × heatAnnealer');
});

test('S1 端到端（成功链）：production pass 行（携带 skills）→ 组合密度进固化器 → 越阈冻结', () => {
  const tel = new MemoryTelemetry();
  for (let i = 0; i < 3; i++) {
    tel.record(
      observation({
        verdict: 'pass',
        operator: 'suite',
        configSnapshot: { skills: ['b', 'a', 'a'] },
      }),
    );
  }
  const collector = new EvolutionSignalCollector({ telemetry: tel });
  const signals = collector.collect();
  assert.strictEqual(signals.length, 3);
  assert.ok(signals.every((s) => s.kind === 'success'));
  assert.strictEqual(signals[0]!.key, 'a|b', '组合键应去重升序（与固化器 comboKey 同构）');
  assert.deepStrictEqual(signals[0]!.success?.combination, ['a', 'b']);

  const registry = new SkillRegistry();
  const member = (name: string): Skill => ({
    name,
    description: `${name} 描述`,
    instructions: `${name} 步骤`,
  });
  registry.register(member('a'));
  registry.register(member('b'));
  const crystallizer = new CapabilityCrystallizer({ skillPort: registry, densityThreshold: 3 });
  for (const s of signals) crystallizer.observe(s.success!.combination);
  assert.strictEqual(crystallizer.density(['a', 'b']), 3, '三条成功信号应把组合密度推到阈值');
  const report = crystallizer.crystallize();
  assert.strictEqual(report.frozen.length, 1, '越阈组合应冻结为原生能力（成功信号真正喂到固化器）');
});

test('S1 变异判据：掐断信号源 ⇒ 提案数与密度增量恒 0', () => {
  // 掐断方式一：构造时不给遥测端口。
  const severed = new EvolutionSignalCollector({});
  assert.strictEqual(severed.collect().length, 0, '无信号源必须恒出空信号流');
  // 掐断方式二：信号源在，但没有任何行。
  const tel = new MemoryTelemetry();
  const empty = new EvolutionSignalCollector({ telemetry: tel });
  assert.strictEqual(empty.collect().length, 0);

  const miner = new FailurePatternMiner(3);
  const registry = new SkillRegistry();
  const crystallizer = new CapabilityCrystallizer({ skillPort: registry, densityThreshold: 3 });
  for (const batch of [severed.collect(), empty.collect()]) {
    const records = failureRecordsOf(batch);
    assert.strictEqual(miner.mine(records).proposals.length, 0, '无信号 ⇒ 无提案');
    for (const s of batch) crystallizer.observe(s.success?.combination ?? []);
    assert.strictEqual(crystallizer.frozen().length, 0, '无信号 ⇒ 无密度增量 ⇒ 无冻结');
  }
});

test('S1 遥测纪律：provenance 非 production 的行不入信号（但游标照常消费）', () => {
  const tel = new MemoryTelemetry();
  tel.record(observation({ verdict: 'fail', provenance: 'seed-bootstrap' }));
  tel.record(observation({ verdict: 'fail', provenance: 'synthetic-lab' }));
  tel.record(
    observation({
      verdict: 'pass',
      configSnapshot: { skills: ['x', 'y'] },
      provenance: 'seed-bootstrap',
    }),
  );
  const collector = new EvolutionSignalCollector({ telemetry: tel });
  assert.deepStrictEqual(collector.collect(), [], '合成/种子行永不入信号');
  // 游标已推进：此后新增的 production 行仍正常产出（被拒行不会回头重来）。
  tel.record(observation({ verdict: 'fail' }));
  const signals = collector.collect();
  assert.strictEqual(signals.length, 1, '只有新 production 行产信号');
  assert.strictEqual(signals[0]!.kind, 'failure');
});

test('S1 游标语义：同一观测行绝不出两次信号；新行追加后只出增量', () => {
  const tel = new MemoryTelemetry();
  tel.record(observation({ verdict: 'fail' }));
  const collector = new EvolutionSignalCollector({ telemetry: tel });
  const first = collector.collect();
  assert.strictEqual(first.length, 1);
  assert.deepStrictEqual(collector.collect(), [], '重复 collect 不得重复出信号');
  tel.record(observation({ verdict: 'pass', configSnapshot: { skills: ['m', 'n'] } }));
  const second = collector.collect();
  assert.strictEqual(second.length, 1, '只出新行的信号');
  assert.strictEqual(second[0]!.kind, 'success');
});

test('S1 映射口径：constrained 属失败摩擦；无组合的 pass 行不产信号', () => {
  const tel = new MemoryTelemetry();
  tel.record(observation({ verdict: 'constrained', metrics: { budget: 1 } }));
  tel.record(observation({ verdict: 'pass' }));
  const collector = new EvolutionSignalCollector({ telemetry: tel });
  const signals = collector.collect();
  assert.strictEqual(signals.length, 1, 'pass 无 skills ⇒ 无 success 信号');
  assert.strictEqual(signals[0]!.kind, 'failure');
  assert.match(signals[0]!.evidence, /verdict=constrained/);
});

test('S1 有界缓冲：maxBatch 硬上限分批消费，总量不丢', () => {
  const tel = new MemoryTelemetry();
  for (let i = 0; i < 5; i++) tel.record(observation({ verdict: 'fail' }));
  const collector = new EvolutionSignalCollector({ telemetry: tel, maxBatch: 2 });
  assert.strictEqual(collector.collect().length, 2, '单次采集受 maxBatch 硬上限');
  const second = collector.collect();
  assert.strictEqual(second.length, 2);
  assert.strictEqual(collector.collect().length, 1, '剩余行随后续 collect 全量给出（不丢）');
  assert.strictEqual(collector.collect().length, 0);
});
