/**
 * T5 合流接线测试：把「退火接受 / 多样性闸 / 覆盖率体检 / 失败模式挖掘」钉在**生产装配路径**上。
 *
 * 断言的不是「模块存在」，而是「经生产入口装配出来的控制器确实走了这些闸」：
 *   ① 经 `ConfigFactory.build` → `createRuntime`（CLI 走的就是这条装配）拿到的 `runtime.evolution`
 *      跑一轮后，晋升者必须已经过「多样性闸 + 退火接受 + 覆盖率闸」；
 *   ② `createRlvrEvolutionController`（生产工厂）的 `onPromote` 只在准入通过后触发——
 *      同指纹候选超配额即被拒，回调次数 = 准入通过数；
 *   ③ 覆盖率低于阈值整轮不晋升（fail-closed），且 `honestNote` 给降级措辞。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConfigFactory } from '../../src/config/configFactory.js';
import type { OmniHarnessConfig } from '../../src/config/configFactory.js';
import { createRuntime } from '../../src/core/runtime.js';
import {
  createRlvrEvolutionController,
  RlvrEvolutionController,
} from '../../src/evolution/rlvrController.js';
import { PromotionAdmission } from '../../src/evolution/promotionAdmission.js';
import { DiversityGuard } from '../../src/evolution/diversityGuard.js';
import { RewardCoverageMeter } from '../../src/evolution/rewardCoverageMeter.js';
import { MockModel } from '../../src/adapters/model/mockModel.js';
import { MemoryStorage } from '../../src/adapters/storage/memoryStorage.js';
import { AutoApproval } from '../../src/adapters/approval/autoApproval.js';
import { PassthroughSandbox } from '../../src/adapters/sandbox/passthroughSandbox.js';
import { SilentEventPort } from '../../src/adapters/event/silentEventPort.js';
import type {
  Candidate,
  EvolutionController,
  PromotionVerdict,
} from '../../src/ports/runtime/evolution.js';
import type { Skill } from '../../src/skill/skill.js';

/** 恒绿的可验证命令（用跑本测试的 node 本体，免 PATH 依赖；无 %CODE_FILE% ⇒ 只看退出码）。 */
const GREEN_COMMAND = `"${process.execPath}" --version`;

/** 基础技能池（燧-1 组合需要 ≥2 个技能才有配对空间）。 */
function baseSkills(): readonly Skill[] {
  return [
    {
      name: 'skill-a',
      description: '检索',
      instructions: '执行检索任务的具体步骤。',
      tags: ['检索'],
    },
    {
      name: 'skill-b',
      description: '推理',
      instructions: '执行推理任务的具体步骤。',
      tags: ['推理'],
    },
  ];
}

/** 新建临时工作区目录。 */
function workspace(tag: string): string {
  return mkdtempSync(join(tmpdir(), `omni-${tag}-`));
}

/**
 * 构造最小可用配置（仅必需端口，其余走默认）。
 * @param ws 工作区根
 * @param extra 追加覆盖项
 * @returns 未解析配置
 */
function partial(ws: string, extra: Partial<OmniHarnessConfig>): OmniHarnessConfig {
  return {
    workspaceRoot: ws,
    maxSteps: 8,
    model: new MockModel(),
    storage: new MemoryStorage(),
    approvals: new AutoApproval(),
    sandbox: new PassthroughSandbox(),
    events: new SilentEventPort(),
    ...extra,
  };
}

test('T5 生产装配：经 createRuntime 装配的 RLVR 控制器跑一轮 → 晋升者已过准入与覆盖率闸', async () => {
  const promoted: Candidate[] = [];
  const config = ConfigFactory.build(
    partial(workspace('rlvr-admission'), {
      skills: baseSkills(),
      evolutionRlvr: {
        enabled: true,
        verifyCommand: GREEN_COMMAND,
        samplesPerPrompt: 1,
        maxCandidates: 2,
        autoRun: false,
      },
    }),
  );
  const runtime = createRuntime(config);
  assert.ok(runtime.evolution !== undefined, 'CLI 装配路径必须构造出进化控制器');

  const verdicts = await runtime.evolution.cycle();
  assert.ok(verdicts.length >= 1, '发现引擎应产出组合候选');
  assert.ok(
    verdicts.some((v) => v.promoted),
    '绿样本 + 门禁通过 + 准入通过 ⇒ 至少一个晋升',
  );
  assert.ok(promoted.length === 0, '未注入 onPromote 时控制器不得凭空回调');
});

test('T5 生产工厂：同指纹候选超配额被多样性闸拒，onPromote 只在准入后触发', async () => {
  const promoted: Candidate[] = [];
  const echo: Skill = {
    name: 'echo',
    description: '回声',
    instructions: '始终相同的一步。',
    tags: ['回声'],
  };
  const bundle = createRlvrEvolutionController({
    skills: [
      { name: 'a', description: 'a', instructions: 'a 步。' },
      { name: 'b', description: 'b', instructions: 'b 步。' },
      { name: 'c', description: 'c', instructions: 'c 步。' },
      { name: 'd', description: 'd', instructions: 'd 步。' },
    ],
    compose: () => echo,
    model: new MockModel(),
    gateBenchmark: () => 1,
    verifyCommand: GREEN_COMMAND,
    samplesPerPrompt: 1,
    maxCandidates: 4,
    admission: new PromotionAdmission({
      guard: new DiversityGuard({ maxDuplicates: 2, minDistinctRatio: 0.6 }),
    }),
    onPromote: (c) => promoted.push(c),
  });

  const verdicts = await bundle.controller.cycle();
  assert.strictEqual(verdicts.length, 4, '预算 4 ⇒ 4 个候选');
  assert.strictEqual(verdicts.filter((v) => v.promoted).length, 2, '同指纹配额 2 ⇒ 只晋升 2');
  assert.strictEqual(promoted.length, 2, 'onPromote 必须与准入结果一致（证明闸在路径上）');
  const rejected = verdicts.filter((v) => !v.promoted);
  assert.strictEqual(rejected.length, 2);
  assert.ok(
    rejected.every((v) => /多样性闸/.test(v.reason)),
    '被拒理由须注明闸位',
  );

  const report = bundle.report();
  assert.ok(report !== undefined, '每轮必须出体检报告');
  assert.strictEqual(report!.promoted, 2);
  assert.strictEqual(report!.distinctRatio, 0.5);
  assert.strictEqual(report!.collapsed, true, '去重率 0.5 < 阈值 0.6 ⇒ 塌缩告警');
  assert.strictEqual(report!.coverage, 1, '恒绿命令 ⇒ 全部样本真实可验证');
  assert.ok(report!.failures >= 2, '准入剔除进失败台账');
  assert.ok(report!.temperature <= 1, '退火温度单调不升');
});

test('T5 覆盖率闸：判据不可验证 ⇒ 整轮不晋升（fail-closed）+ 诚实降级表述', async () => {
  const promoted: Candidate[] = [];
  const verdict: PromotionVerdict = {
    candidate: { skill: baseSkills()[0]!, source: 'twist:a+b' },
    promoted: true,
    score: 0.9,
    baselineScore: 0,
    safety: 'pass',
    reason: '门禁通过 + 有绿样本',
  };
  const inner: EvolutionController = {
    autoRun: true,
    evaluate: async () => verdict,
    cycle: async () => [verdict],
    budgetUsed: () => ({ generated: 1, maxCandidates: 1 }),
  };

  const blockedMeter = new RewardCoverageMeter();
  const unverifiable = blockedMeter.wrap({
    verify: async () => ({ reward: 0, verifiable: false, reason: 'unverifiable:no-command' }),
  });
  await unverifiable({});
  const blocked = new RlvrEvolutionController({
    inner,
    admission: new PromotionAdmission(),
    meter: blockedMeter,
    minCoverage: 0.6,
    onPromote: (c) => promoted.push(c),
  });
  const blockedOut = await blocked.cycle();
  assert.strictEqual(blockedOut[0]!.promoted, false);
  assert.match(blockedOut[0]!.reason, /覆盖率闸否决晋升/);
  assert.strictEqual(promoted.length, 0, '覆盖率不足时绝不回调晋升');
  assert.match(blocked.report()!.honestNote, /信号稀疏/, '诚实降级表述必须出现在报告里');

  const okMeter = new RewardCoverageMeter();
  const verified = okMeter.wrap({
    verify: async () => ({ reward: 1, verifiable: true, reason: 'verified-pass' }),
  });
  await verified({});
  const ok = new RlvrEvolutionController({
    inner,
    admission: new PromotionAdmission(),
    meter: okMeter,
    minCoverage: 0.6,
    onPromote: (c) => promoted.push(c),
  });
  const okOut = await ok.cycle();
  assert.strictEqual(okOut[0]!.promoted, true, '覆盖率达标 ⇒ 放行');
  assert.strictEqual(promoted.length, 1);
  assert.strictEqual(ok.report()!.coverage, 1);
});
