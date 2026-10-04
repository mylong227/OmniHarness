/**
 * S2（GEE Kernel v1 · ADR-0008）：Kernel 编排 + 装配判据。
 *
 * 蓝图判据（EVOLUTION_ARCH_UPGRADE_2026-10 §4 S2）：
 * - 开关 off ⇒ `runtime.evolution` 行为与现状逐项等价（装配的是既有 RLVR 控制器，非 Kernel）；
 * - on ⇒ Kernel 实例且 `cycle()` 走七环（信号路由 / 档案 / 晋升 / 观测可证）；
 * - kernel 内部异常 ⇒ 只告警不影响主任务（`cycle()` 不抛、返回空裁决流）；
 * - 附加：晋升回调接管（内层不持 onPromote）/ 负结果冻结与复核上限 / 晋升者永不复活 /
 *   发现源保鲜（新技能进池）/ CLI 旗标与配置文件双通道透传。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConfigFactory } from '../../src/config/configFactory.js';
import type { OmniHarnessConfig } from '../../src/config/configFactory.js';
import { Runtime } from '../../src/composition/runtime.js';
import { RlvrController } from '../../src/evolution/rlvrController.js';
import { EvolutionKernel } from '../../src/evolution/evolutionKernel.js';
import { EvolutionSignalCollector } from '../../src/evolution/evolutionSignalCollector.js';
import { BucketedCandidateArchive } from '../../src/evolution/bucketedCandidateArchive.js';
import { EliteReentryDiscovery } from '../../src/evolution/eliteReentryDiscovery.js';
import { HashChainPromotionLedger } from '../../src/evolution/hashChainPromotionLedger.js';
import { TwistDiscoveryEngine } from '../../src/evolution/twistDiscoveryEngine.js';
import { ArgParser } from '../../src/cli/argParser.js';
import { MoireComposer } from '../../src/skill/moireComposer.js';
import { SkillRegistry } from '../../src/skill/skillRegistry.js';
import { CapabilityCrystallizer } from '../../src/adapters/skill/capabilityCrystallizer.js';
import { MemoryStorage } from '../../src/adapters/storage/memoryStorage.js';
import { AutoApproval } from '../../src/adapters/approval/autoApproval.js';
import { PassthroughSandbox } from '../../src/adapters/sandbox/passthroughSandbox.js';
import { SilentEventPort } from '../../src/adapters/event/silentEventPort.js';
import type { ModelPort } from '../../src/ports/model/model.js';
import type { Skill } from '../../src/skill/skill.js';
import type { EvolutionController, PromotionVerdict } from '../../src/ports/runtime/evolution.js';
import type {
  RuntimeObservation,
  RuntimeTelemetryInput,
  RuntimeTelemetryPort,
  TelemetryChainReport,
} from '../../src/ports/runtime/runtimeTelemetry.js';

/** 可验证奖励命令（hermetic：用本测试进程的 node 做 `--check` 语法检查）。 */
const VERIFY_COMMAND = `"${process.execPath}" --check %CODE_FILE%`;

/** 语法合法的候选代码（`node --check` 必绿）。 */
const GREEN_CODE = 'const add = (a, b) => a + b;\n';

/** 固定时间戳（确定性）。 */
const TS = '2026-10-04T00:00:00.000Z';

/**
 * 假模型：不论 prompt 一律产出固定代码围栏。
 * @param code 围栏内代码内容
 * @returns 固定输出的 ModelPort
 */
function fixedModel(code: string): ModelPort {
  return {
    generate: async () => ({ text: '```js\n' + code + '```' }),
  } as unknown as ModelPort;
}

/**
 * 两个基础技能（供燧-1 组合发现）。
 * @returns 技能池
 */
function baseSkills(): readonly Skill[] {
  return [
    { name: 'skill-a', description: '检索', instructions: '检索步骤。', tags: ['检索'] },
    { name: 'skill-b', description: '推理', instructions: '推理步骤。', tags: ['推理'] },
  ];
}

/**
 * 内存遥测桩（append-only + 链序号自增）。
 */
class MemoryTelemetry implements RuntimeTelemetryPort {
  /** 端口名（契约字段）。 */
  public readonly name = 'memory-telemetry';
  /** 已落盘观测。 */
  private readonly rows: RuntimeObservation[] = [];

  /**
   * 落盘一条观测。
   * @param input 观测输入
   * @returns 链序号
   */
  public record(input: RuntimeTelemetryInput): number | undefined {
    const seq = this.rows.length + 1;
    this.rows.push({ ...input, ts: input.ts ?? TS, seq, prev: '0'.repeat(64), hash: `h${seq}` });
    return seq;
  }

  /**
   * 读取全部观测。
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
 * 造一条 production 观测行。
 * @param overrides 覆盖字段
 * @returns 记录输入
 */
function productionRow(
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
 * 构造最小可用未解析配置。
 * @param model 模型端口
 * @param extra 追加覆盖项
 * @returns OmniHarnessConfig
 */
function basePartial(model: ModelPort, extra: Partial<OmniHarnessConfig> = {}): OmniHarnessConfig {
  return {
    workspaceRoot: mkdtempSync(join(tmpdir(), 'omni-kernel-')),
    maxSteps: 8,
    model,
    storage: new MemoryStorage(),
    approvals: new AutoApproval(),
    sandbox: new PassthroughSandbox(),
    events: new SilentEventPort(),
    ...extra,
  };
}

/**
 * 抛错内层控制器（fail-closed 判据用）。
 * @returns 恒抛错的 EvolutionController
 */
function throwingInner(): EvolutionController {
  return {
    autoRun: false,
    evaluate: () => Promise.reject(new Error('boom')),
    cycle: () => Promise.reject(new Error('boom')),
    budgetUsed: () => ({ generated: 0, maxCandidates: 0 }),
  };
}

/**
 * 造「内层一次吐出给定裁决」的桩控制器。
 * @param verdicts 桩裁决流
 * @returns 桩控制器
 */
function stubInner(verdicts: readonly PromotionVerdict[]): EvolutionController {
  return {
    autoRun: false,
    evaluate: (c) =>
      Promise.resolve({
        candidate: c,
        promoted: false,
        score: 0,
        baselineScore: 0,
        safety: 'pass',
        reason: 'stub',
      }),
    cycle: () => Promise.resolve(verdicts),
    budgetUsed: () => ({ generated: verdicts.length, maxCandidates: verdicts.length }),
  };
}

/**
 * 造一条晋升裁决。
 * @param name 技能名
 * @returns 晋升裁决
 */
function promotedVerdict(name: string): PromotionVerdict {
  return {
    candidate: {
      skill: { name, description: name, instructions: `${name} 步骤` },
      source: 'twist:x',
    },
    promoted: true,
    score: 0.9,
    baselineScore: 0.5,
    safety: 'pass',
    reason: 'test',
  };
}

test('S2 开关 off：装配的是既有 RLVR 控制器（非 Kernel），行为与现状等价', () => {
  const config = ConfigFactory.build(
    basePartial(fixedModel(GREEN_CODE), {
      skills: baseSkills(),
      evolutionRlvr: { enabled: true, verifyCommand: VERIFY_COMMAND, autoRun: true },
    }),
  );
  const runtime = Runtime.createRuntime(config);
  assert.ok(runtime.evolution !== undefined);
  assert.ok(
    !(runtime.evolution instanceof EvolutionKernel),
    'kernel 缺省关 → 不得装配 EvolutionKernel',
  );
  assert.strictEqual(runtime.evolution.autoRun, true);
});

test('S2 开关 on：装配 EvolutionKernel 且 autoRun 忠实透传', () => {
  const config = ConfigFactory.build(
    basePartial(fixedModel(GREEN_CODE), {
      skills: baseSkills(),
      evolutionRlvr: {
        enabled: true,
        kernel: true,
        verifyCommand: VERIFY_COMMAND,
        autoRun: true,
      },
    }),
  );
  const runtime = Runtime.createRuntime(config);
  assert.ok(
    runtime.evolution instanceof EvolutionKernel,
    'kernel:on → runtime.evolution 是 Kernel',
  );
  assert.strictEqual(runtime.evolution.autoRun, true, 'autoRun 应忠实透传');
});

test('S2 七环端到端：信号路由 / 档案入桶 / 晋升接管 / 固化器密度 / 观测报告', async () => {
  const tel = new MemoryTelemetry();
  for (let i = 0; i < 3; i++) tel.record(productionRow({ verdict: 'fail', metrics: { drift: i } }));
  tel.record(
    productionRow({
      verdict: 'pass',
      operator: 'suite',
      configSnapshot: { skills: ['skill-a', 'skill-b'] },
    }),
  );

  const registry = new SkillRegistry();
  for (const s of baseSkills()) registry.register(s);
  const archive = new BucketedCandidateArchive({});
  const reentry = new EliteReentryDiscovery({
    inner: new TwistDiscoveryEngine({
      skills: () => registry.list(),
      compose: (a, b, o) => MoireComposer.composeByTwist(a, b, o),
      maxCandidates: 12,
    }),
  });
  const bundle = RlvrController.createRlvrEvolutionController({
    skills: registry.list(),
    compose: (a, b, o) => MoireComposer.composeByTwist(a, b, o),
    model: fixedModel(GREEN_CODE),
    gateBenchmark: () => 1,
    minReward: 0,
    verifyCommand: VERIFY_COMMAND,
    verifyCodeFileExtension: '.js',
    samplesPerPrompt: 2,
    discovery: reentry,
  });
  const crystallizer = new CapabilityCrystallizer({ skillPort: registry, densityThreshold: 3 });
  const promotedNames: string[] = [];
  const ledger = new HashChainPromotionLedger({});
  const kernel = new EvolutionKernel({
    inner: bundle.controller,
    signals: new EvolutionSignalCollector({ telemetry: tel }),
    archive,
    reentry,
    crystallizer,
    ledger,
    skillsProvider: () => registry.list(),
    onPromote: (c) => {
      registry.replace(c.skill);
      promotedNames.push(c.skill.name);
    },
  });

  const verdicts = await kernel.cycle();
  const report = kernel.report();
  assert.ok(report !== undefined, 'cycle 后应有体检报告');
  assert.strictEqual(report.signals, 4, '四条 production 行应全部采集');
  assert.strictEqual(report.failures, 3, '失败信号应路由进挖掘器');
  assert.strictEqual(report.successObservations, 1, '成功组合应喂给固化器');
  assert.strictEqual(
    crystallizer.density(['skill-a', 'skill-b']),
    1,
    '成功信号应抬升固化器组合密度',
  );
  assert.ok(verdicts.length >= 1, '应产出候选裁决');
  assert.ok(
    verdicts.some((v) => v.promoted),
    '绿样本候选应晋升',
  );
  assert.strictEqual(
    promotedNames.length,
    verdicts.filter((v) => v.promoted).length,
    '晋升应走 Kernel 接管回调',
  );
  assert.ok(report.archived >= verdicts.length, '候选应全部入档');
  assert.ok(report.degraded.length === 0, '满配装配不得有降级申报');
  assert.ok(
    verdicts
      .filter((v) => v.promoted)
      .every((v) => registry.get(v.candidate.skill.name) !== undefined),
    '晋升技能应真实落进注册表',
  );

  // 第二轮：晋升技能经实读技能源回流注册表 → 新配对继续涌现（发现源保鲜的正向飞轮）；
  // 档案侧：晋升者已 'promoted' 永久退役 → 复活与重入恒为 0。
  await kernel.cycle();
  assert.strictEqual(kernel.report()?.revived, 0, '晋升者退役后不得复活');
  assert.strictEqual(kernel.report()?.reentryPending, 0, '无负结果 → 重入队列恒空');
});

test('S2 信号 → 提案：同签名失败 ≥3 次经 Kernel 路由后升格改进提案', async () => {
  const tel = new MemoryTelemetry();
  for (let i = 0; i < 3; i++) {
    tel.record(productionRow({ verdict: 'fail', operator: 'immuneMonitoring' }));
  }
  const kernel = new EvolutionKernel({
    inner: stubInner([]),
    signals: new EvolutionSignalCollector({ telemetry: tel }),
  });
  await kernel.cycle();
  const report = kernel.report();
  assert.ok(report !== undefined);
  assert.strictEqual(report.proposals.length, 1, '同签名失败 ×3 应升格为防再犯提案');
  assert.match(report.proposals[0] ?? '', /telemetry:cycle × immuneMonitoring/);
});

test('S2 fail-closed：内层异常 → cycle() 只告警并返回空裁决流，绝不外抛', async () => {
  const kernel = new EvolutionKernel({ inner: throwingInner() });
  const verdicts = await kernel.cycle();
  assert.deepStrictEqual(verdicts, [], '内层抛错 → 空裁决流（fail-closed）');
});

test('S2 晋升回调单点失败不连累其余晋升', async () => {
  const verdicts = [promotedVerdict('s-a'), promotedVerdict('s-b')];
  const promoted: string[] = [];
  const kernel = new EvolutionKernel({
    inner: stubInner(verdicts),
    ledger: new HashChainPromotionLedger({}),
    skillsProvider: () => [],
    onPromote: (c) => {
      if (c.skill.name === 's-a') throw new Error('promote boom');
      promoted.push(c.skill.name);
    },
  });
  await kernel.cycle();
  const report = kernel.report();
  assert.deepStrictEqual(promoted, ['s-b'], 's-a 晋升失败不得影响 s-b');
  assert.strictEqual(report?.promoted, 1);
});

test('S2 档案纪律：负结果冻结退出精英流，同工况复现复活，复核超限退役停复活', async () => {
  const registry = new SkillRegistry();
  const skills: readonly Skill[] = [
    { name: 'a', description: 'a', instructions: 'a 步骤。' },
    { name: 'b', description: 'b', instructions: 'b 步骤。' },
    { name: 'c', description: 'c', instructions: 'c 步骤。' },
  ];
  for (const s of skills) registry.register(s);
  // 桶容量放大到 12：本测考「冻结/复活/退役」纪律，不与容量淘汰语义耦合（6 条候选共存）。
  const archive = new BucketedCandidateArchive({ maxPerBucket: 12 });
  const reentry = new EliteReentryDiscovery({
    inner: new TwistDiscoveryEngine({
      skills: () => registry.list(),
      compose: (a, b, o) => MoireComposer.composeByTwist(a, b, o),
      maxCandidates: 12,
    }),
  });
  const bundle = RlvrController.createRlvrEvolutionController({
    skills: registry.list(),
    compose: (a, b, o) => MoireComposer.composeByTwist(a, b, o),
    model: fixedModel(GREEN_CODE),
    gateBenchmark: () => 0,
    minReward: 0,
    verifyCommand: VERIFY_COMMAND,
    verifyCodeFileExtension: '.js',
    samplesPerPrompt: 1,
    discovery: reentry,
  });
  const kernel = new EvolutionKernel({
    inner: bundle.controller,
    archive,
    reentry,
    maxRecheckAttempts: 3,
  });

  // R1：3 个 twist 候选全被拒 → 冻结退出精英流；无早前冻结者 → 无复活。
  await kernel.cycle();
  assert.strictEqual(archive.elites('twist').length, 0, '全被拒 → 冻结退出精英流');
  assert.strictEqual(kernel.report()?.revived, 0, '同轮冻结者不得同轮复活');
  // R2：新技能注册 → 同桶复现 → R1 冻结者复活进入重入流。
  registry.register({ name: 'd', description: 'd', instructions: 'd 步骤。' });
  await kernel.cycle();
  assert.strictEqual(kernel.report()?.revived, 3, '同工况复现 → 早前冻结者复活');
  // R3–R7：P/D 两组轮转复核（每轮复活另一组，strikes 逐次 +1，均未超限）。
  for (let i = 0; i < 5; i++) {
    await kernel.cycle();
    assert.strictEqual(kernel.report()?.revived, 3, `轮 ${i + 3}：复核未超限 → 继续轮转复活`);
  }
  // R8：复核次数耗尽（3 次）→ 退役停复活；R9 起恒无复活（负结果留档但不再空转）。
  await kernel.cycle();
  assert.strictEqual(kernel.report()?.revived, 0, '复核 3 次仍被拒 → 退役停复活');
  assert.strictEqual(reentry.pending(), 0, '退役后重入队列清空');
  await kernel.cycle();
  assert.strictEqual(kernel.report()?.revived, 0, '退役后恒无复活');
});

test('S2 发现源保鲜：运行中注册的新技能进入组合池（修构造时快照缺陷）', () => {
  const registry = new SkillRegistry();
  registry.register({ name: 'a', description: 'a', instructions: 'a 步骤。' });
  registry.register({ name: 'b', description: 'b', instructions: 'b 步骤。' });
  const engine = new TwistDiscoveryEngine({
    skills: () => registry.list(),
    compose: (x, y) => MoireComposer.composeByTwist(x, y),
    maxCandidates: 12,
  });
  const first = engine.nextCandidates();
  assert.strictEqual(first.length, 1, '两技能 → 一对组合');
  registry.register({ name: 'c', description: 'c', instructions: 'c 步骤。' });
  const second = engine.nextCandidates();
  assert.strictEqual(
    second.length,
    2,
    '新注册技能应产生新配对（a+c、b+c），而非被构造时快照挡在池外',
  );
  assert.ok(
    second.every((c) => c.source === 'twist:a+c' || c.source === 'twist:b+c'),
    `新配对应只涉及新技能：${second.map((c) => c.source).join(', ')}`,
  );
  const third = engine.nextCandidates();
  assert.deepStrictEqual(third, [], '配对空间用尽 → 空批（预算与去重纪律不变）');
});

test('S2 入口（argv）：--evolution-kernel 系列旗标解析为 CliArgs 字段', () => {
  const args = ArgParser.parseArgs([
    '--prompt',
    'hi',
    '--evolution-rlvr',
    '--evolution-kernel',
    '--rlvr-ledger-dir',
    'custom/dir',
    '--rlvr-archive-max',
    '6',
  ]);
  assert.ok(args !== undefined);
  assert.strictEqual(args.evolutionKernel, true);
  assert.strictEqual(args.rlvrLedgerDir, 'custom/dir');
  assert.strictEqual(args.rlvrArchiveMax, 6);
});

test('S2 入口（配置文件）：evolutionRlvr 的 kernel 子键映射为 CliArgs 字段', () => {
  const mapped = ArgParser.configDefaults({
    evolutionRlvr: {
      enabled: true,
      kernel: true,
      ledgerDir: 'ledger/dir',
      archiveMaxPerBucket: 8,
    },
  });
  assert.strictEqual(mapped.evolutionKernel, true);
  assert.strictEqual(mapped.rlvrLedgerDir, 'ledger/dir');
  assert.strictEqual(mapped.rlvrArchiveMax, 8);
});

test('S3 晋升前快照：先 snapshotBefore 后晋升，快照携带晋升前全量表且验签绿', async () => {
  const registry = new SkillRegistry();
  for (const s of baseSkills()) registry.register(s);
  const dir = mkdtempSync(join(tmpdir(), 'omni-k3-'));
  const ledger = new HashChainPromotionLedger({ dir });
  const bundle = RlvrController.createRlvrEvolutionController({
    skills: registry.list(),
    compose: (a, b, o) => MoireComposer.composeByTwist(a, b, o),
    model: fixedModel(GREEN_CODE),
    gateBenchmark: () => 1,
    minReward: 0,
    verifyCommand: VERIFY_COMMAND,
    verifyCodeFileExtension: '.js',
    samplesPerPrompt: 2,
  });
  const kernel = new EvolutionKernel({
    inner: bundle.controller,
    ledger,
    skillsProvider: () => registry.list(),
    onPromote: (c) => registry.replace(c.skill),
  });

  const verdicts = await kernel.cycle();
  const promoted = verdicts.filter((v) => v.promoted);
  assert.ok(promoted.length >= 1, '绿样本候选应晋升');
  const report = kernel.report();
  assert.strictEqual(report?.snapshotSeq, 1, '本轮首个晋升者之前应落下快照（seq=1）');
  assert.strictEqual(ledger.verify().ok, true, '台账链完整');
  const lines = readFileSync(join(dir, 'ledger.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0);
  const snapshot = JSON.parse(lines[0]!) as { action: string; skills: readonly Skill[] };
  assert.strictEqual(snapshot.action, 'snapshot');
  assert.deepStrictEqual(
    snapshot.skills.map((s) => s.name).sort(),
    ['skill-a', 'skill-b'],
    '快照 = 晋升前全量表（不含尚未晋升的候选）',
  );
  assert.strictEqual(lines.length, 1 + promoted.length, '每条晋升对应一个 promote 条目');
});

test('S3 fail-closed：台账缺失 ⇒ 晋升裁决被改写为未晋升，晋升回调绝不触发', async () => {
  const verdicts = [promotedVerdict('s-a'), promotedVerdict('s-b')];
  const promoted: string[] = [];
  const kernel = new EvolutionKernel({
    inner: stubInner(verdicts),
    onPromote: (c) => promoted.push(c.skill.name),
  });
  const final = await kernel.cycle();
  assert.strictEqual(
    final.filter((v) => v.promoted).length,
    0,
    '无台账 → 所有晋升裁决 fail-closed 改写为未晋升',
  );
  assert.match(final[0]!.reason, /无快照不晋升/);
  assert.match(final[1]!.reason, /无快照不晋升/);
  assert.deepStrictEqual(promoted, [], '晋升回调不得触发（不允许无快照晋升）');
  assert.strictEqual(kernel.report()?.promoted, 0);
  assert.ok(
    kernel.report()?.degraded.includes('promotion-ledger:missing'),
    '台账缺失必须如实申报进降级口径',
  );
});

test('S3 回滚端到端：rollback(snapshotSeq) 后技能表与快照逐条深相等（晋升者被移除）', async () => {
  const registry = new SkillRegistry();
  for (const s of baseSkills()) registry.register(s);
  const ledger = new HashChainPromotionLedger({});
  const bundle = RlvrController.createRlvrEvolutionController({
    skills: registry.list(),
    compose: (a, b, o) => MoireComposer.composeByTwist(a, b, o),
    model: fixedModel(GREEN_CODE),
    gateBenchmark: () => 1,
    minReward: 0,
    verifyCommand: VERIFY_COMMAND,
    verifyCodeFileExtension: '.js',
    samplesPerPrompt: 2,
  });
  const before = registry.list().map((s) => ({ ...s }));
  const kernel = new EvolutionKernel({
    inner: bundle.controller,
    ledger,
    skillsProvider: () => registry.list(),
    applyRestore: (plan) => {
      const currentNames = registry.list().map((s) => s.name);
      const targets = new Set(plan.skills.map((s) => s.name));
      for (const skill of plan.skills) registry.replace(skill);
      for (const name of currentNames) {
        if (!targets.has(name)) registry.remove(name);
      }
    },
    onPromote: (c) => registry.replace(c.skill),
  });

  await kernel.cycle();
  const afterPromote = registry.list().map((s) => s.name);
  assert.ok(afterPromote.length > before.length, '晋升后注册表应新增技能');
  const snapshotSeq = kernel.report()?.snapshotSeq;
  assert.ok(snapshotSeq !== undefined);
  kernel.rollback(snapshotSeq!);
  assert.deepStrictEqual(
    registry.list(),
    before,
    '回滚后技能表与晋升前快照逐条深相等（晋升者被移除）',
  );
  assert.strictEqual(ledger.verify().ok, true, '回滚事件入链后链仍完整');
});
