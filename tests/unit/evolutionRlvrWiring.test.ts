/**
 * E3：U4 RLVR autoRun 端到端接线测试。
 *
 * 本批修的是一条**此前断裂的链路**（非新增能力）：RLVR 全机器（`RlvrLoop` /
 * `verifiableRewardForCode` / `modelRlvrSampler` / `createRlvrEvolutionController`）早已实现并有组件级单测，
 * 但「配置 → 装配 → 运行时 → cycle」整条链是断的：
 *   ① `ConfigFactory.build` 的返回字面量**未透传** `evolutionRlvr` → 调用方设置也被静默丢弃；
 *   ② 没有任何生产入口（CLI 旗标 / 配置字段 / env）能把它打开。
 * 故「默认关、端到端未开」——此处逐点锁死修复后的行为。
 *
 * 覆盖：
 *   ① 配置透传回归护栏（build 后 `evolutionRlvr` 必须仍在）；
 *   ② 默认关零破坏；
 *   ③ `createRuntime` 显式开启后装配 RLVR 控制器、`autoRun` 忠实透传；
 *   ④ 闭环一例：采样→可验证奖励（真实子进程 `node --check %CODE_FILE%`）→绿样本进回放缓冲；
 *   ⑤ fail-closed：红样本绝不进回放缓冲；
 *   ⑥/⑦ 端到端（经 `createRuntime` 装配的控制器 `cycle()`）：绿样本→晋升，全红→RLVR 否决。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConfigFactory } from '../../src/config/configFactory.js';
import type { OmniHarnessConfig } from '../../src/config/configFactory.js';
import { createRuntime } from '../../src/composition/runtime.js';
import { createRlvrEvolutionController } from '../../src/evolution/rlvrController.js';
import { verifiableVerdictForCode } from '../../src/evolution/verifiableReward.js';
import { parseArgs, configDefaults } from '../../src/cli/argParser.js';
import { composeByTwist } from '../../src/skill/moireComposer.js';
import type { ModelPort } from '../../src/ports/model/model.js';
import type { Skill } from '../../src/skill/skill.js';
import { MemoryStorage } from '../../src/adapters/storage/memoryStorage.js';
import { AutoApproval } from '../../src/adapters/approval/autoApproval.js';
import { PassthroughSandbox } from '../../src/adapters/sandbox/passthroughSandbox.js';
import { SilentEventPort } from '../../src/adapters/event/silentEventPort.js';

/**
 * 可验证奖励命令：用「跑本测试的 node 本体」做语法检查，避免依赖 PATH（hermetic）。
 * 候选代码被 `verifiableRewardForCode` 写入临时 `.ts` 后，`%CODE_FILE%` 替换为该路径。
 */
const VERIFY_COMMAND = `"${process.execPath}" --check %CODE_FILE%`;

/** 语法合法的候选代码（`node --check` 必绿）。 */
const GREEN_CODE = 'const add = (a, b) => a + b;\nconst total = add(1, 2);\n';

/** 语法非法的候选代码（`node --check` 必红）。 */
const RED_CODE = 'const broken = ;\n';

/**
 * 假模型：不论 prompt 一律产出固定代码围栏（供 `modelRlvrSampler` 抽取候选代码）。
 * @param code 围栏内代码内容
 * @returns 固定输出的 ModelPort
 */
function fixedModel(code: string): ModelPort {
  return {
    generate: async () => ({ text: '```js\n' + code + '```' }),
  } as unknown as ModelPort;
}

/**
 * 两个基础技能（供燧-1 组合发现产出组合候选）。
 * @returns 技能池
 */
function baseSkills(): readonly Skill[] {
  return [
    {
      name: 'skill-a',
      description: '检索相关能力',
      instructions: '执行检索任务的具体步骤。',
      tags: ['检索'],
    },
    {
      name: 'skill-b',
      description: '推理相关能力',
      instructions: '执行推理任务的具体步骤。',
      tags: ['推理'],
    },
  ];
}

/**
 * 构造最小可用的未解析运行配置（仅必需端口，其余走默认）。
 * @param workspaceRoot 工作区根
 * @param model 模型端口
 * @param extra 追加覆盖项
 * @returns OmniHarnessConfig
 */
function basePartial(
  workspaceRoot: string,
  model: ModelPort,
  extra: Partial<OmniHarnessConfig> = {},
): OmniHarnessConfig {
  return {
    workspaceRoot,
    maxSteps: 8,
    model,
    storage: new MemoryStorage(),
    approvals: new AutoApproval(),
    sandbox: new PassthroughSandbox(),
    events: new SilentEventPort(),
    ...extra,
  };
}

/** 新建临时工作区目录。 */
function workspace(tag: string): string {
  return mkdtempSync(join(tmpdir(), `omni-${tag}-`));
}

test('E3 装配透传：显式开启的 evolutionRlvr 不再被 ConfigFactory.build 静默丢弃', () => {
  const config = ConfigFactory.build(
    basePartial(workspace('rlvr-wire'), fixedModel(GREEN_CODE), {
      evolutionRlvr: {
        enabled: true,
        verifyCommand: VERIFY_COMMAND,
        verifyCodeFileExtension: '.js',
        samplesPerPrompt: 2,
        autoRun: true,
      },
    }),
  );
  assert.ok(config.evolutionRlvr !== undefined, 'evolutionRlvr 必须活着穿到 ResolvedConfig');
  assert.strictEqual(config.evolutionRlvr.enabled, true);
  assert.strictEqual(config.evolutionRlvr.verifyCommand, VERIFY_COMMAND);
  assert.strictEqual(config.evolutionRlvr.verifyCodeFileExtension, '.js');
  assert.strictEqual(config.evolutionRlvr.samplesPerPrompt, 2);
  assert.strictEqual(config.evolutionRlvr.autoRun, true);
});

test('E3 默认关：不显式开启时零破坏（evolutionRlvr 与 runtime.evolution 均为 undefined）', () => {
  const config = ConfigFactory.build(basePartial(workspace('rlvr-off'), fixedModel(GREEN_CODE)));
  assert.strictEqual(config.evolutionRlvr, undefined, '缺省不得写入 evolutionRlvr');
  const runtime = createRuntime(config);
  assert.strictEqual(runtime.evolution, undefined, '缺省不得装配进化控制器');
});

test('E3 运行时装配：显式开启 → createRuntime 构造 RLVR 控制器且 autoRun 忠实透传', () => {
  const config = ConfigFactory.build(
    basePartial(workspace('rlvr-rt'), fixedModel(GREEN_CODE), {
      skills: baseSkills(),
      evolutionRlvr: { enabled: true, verifyCommand: VERIFY_COMMAND, autoRun: true },
    }),
  );
  const runtime = createRuntime(config);
  assert.ok(runtime.evolution !== undefined, '显式开启且技能注册表在 → 应装配 RLVR 控制器');
  assert.strictEqual(runtime.evolution.autoRun, true, 'autoRun 应来自 evolutionRlvr.autoRun');
});

test('E3 闭环一例：采样 → 可验证奖励（真实 node --check）→ 绿样本进回放缓冲', async () => {
  const bundle = createRlvrEvolutionController({
    skills: baseSkills(),
    compose: (a, b) => composeByTwist(a, b),
    model: fixedModel(GREEN_CODE),
    gateBenchmark: () => 1, // 门禁恒过 → 单独考察 RLVR 阶段
    minReward: 0,
    verifyCommand: VERIFY_COMMAND,
    verifyCodeFileExtension: '.js',
    samplesPerPrompt: 2,
  });

  const verdicts = await bundle.controller.cycle();
  assert.ok(verdicts.length >= 1, '发现引擎应产出组合候选');
  assert.strictEqual(verdicts[0]!.promoted, true, '绿样本存在 → RLVR 未否决 → 晋升');
  assert.ok(bundle.buffer.size >= 1, '绿样本应进入回放缓冲（sample→verify→replay 闭环）');
  assert.ok(bundle.buffer.entries[0]!.reward > 0, '回放样本奖励应为正（可验证奖励 = 编译绿）');
});

test('E3 fail-closed：红样本（编译不过）绝不进回放缓冲且 RLVR 否决晋升', async () => {
  const bundle = createRlvrEvolutionController({
    skills: baseSkills(),
    compose: (a, b) => composeByTwist(a, b),
    model: fixedModel(RED_CODE),
    gateBenchmark: () => 1,
    minReward: 0,
    verifyCommand: VERIFY_COMMAND,
    verifyCodeFileExtension: '.js',
    samplesPerPrompt: 2,
  });

  const verdicts = await bundle.controller.cycle();
  assert.strictEqual(bundle.buffer.size, 0, '红样本不得进回放缓冲');
  assert.strictEqual(verdicts[0]!.promoted, false);
  assert.match(verdicts[0]!.reason, /RLVR/, '否决理由应标明来自 RLVR 阶段');
});

test('E3 端到端：显式开启经 createRuntime 装配后，cycle() 因绿样本晋升', async () => {
  const config = ConfigFactory.build(
    basePartial(workspace('rlvr-e2e'), fixedModel(GREEN_CODE), {
      skills: baseSkills(),
      evolutionRlvr: {
        enabled: true,
        verifyCommand: VERIFY_COMMAND,
        verifyCodeFileExtension: '.js',
        samplesPerPrompt: 2,
        maxCandidates: 4,
      },
    }),
  );
  const runtime = createRuntime(config);
  assert.ok(runtime.evolution !== undefined);
  const verdicts = await runtime.evolution.cycle();
  assert.ok(verdicts.length >= 1, '运行时控制器应产出候选');
  assert.strictEqual(
    verdicts[0]!.promoted,
    true,
    '绿样本存在 → 经运行时装配的 RLVR 控制器放行晋升',
  );
});

test('E3 端到端（全红）：显式开启但候选全红 → 运行时控制器的 RLVR 阶段否决晋升', async () => {
  const config = ConfigFactory.build(
    basePartial(workspace('rlvr-e2e-red'), fixedModel(RED_CODE), {
      skills: baseSkills(),
      evolutionRlvr: {
        enabled: true,
        verifyCommand: VERIFY_COMMAND,
        verifyCodeFileExtension: '.js',
        samplesPerPrompt: 2,
        maxCandidates: 4,
      },
    }),
  );
  const runtime = createRuntime(config);
  assert.ok(runtime.evolution !== undefined);
  const verdicts = await runtime.evolution.cycle();
  assert.ok(verdicts.length >= 1);
  assert.strictEqual(verdicts[0]!.promoted, false);
  assert.match(
    verdicts[0]!.reason,
    /RLVR/,
    '应为 RLVR 阶段否决（证明运行时装配的确实是 RLVR 控制器，而非门禁直接拒绝）',
  );
});

test('E3 入口（argv）：--evolution-rlvr 系列旗标解析为对应 CliArgs 字段', () => {
  const args = parseArgs([
    '--prompt',
    'hi',
    '--evolution-rlvr',
    '--rlvr-verify',
    VERIFY_COMMAND,
    '--rlvr-samples',
    '3',
    '--rlvr-min-reward',
    '0.5',
    '--rlvr-candidates',
    '9',
    '--rlvr-min-gain',
    '0.2',
    '--rlvr-auto-run',
  ]);
  assert.ok(args !== undefined);
  assert.strictEqual(args.evolutionRlvr, true);
  assert.strictEqual(args.rlvrVerify, VERIFY_COMMAND);
  assert.strictEqual(args.rlvrSamples, 3);
  assert.strictEqual(args.rlvrMinReward, 0.5);
  assert.strictEqual(args.rlvrCandidates, 9);
  assert.strictEqual(args.rlvrMinGain, 0.2);
  assert.strictEqual(args.rlvrAutoRun, true);
});

test('E3 入口（配置文件）：omniharness.json 的 evolutionRlvr 对象映射为 CliArgs 字段', () => {
  const mapped = configDefaults({
    evolutionRlvr: {
      enabled: true,
      verifyCommand: VERIFY_COMMAND,
      samplesPerPrompt: 4,
      minReward: 0.25,
      maxCandidates: 6,
      minGain: 0.1,
      autoRun: true,
    },
  });
  assert.strictEqual(mapped.evolutionRlvr, true);
  assert.strictEqual(mapped.rlvrVerify, VERIFY_COMMAND);
  assert.strictEqual(mapped.rlvrSamples, 4);
  assert.strictEqual(mapped.rlvrMinReward, 0.25);
  assert.strictEqual(mapped.rlvrCandidates, 6);
  assert.strictEqual(mapped.rlvrMinGain, 0.1);
  assert.strictEqual(mapped.rlvrAutoRun, true);
});

test('U4 桥：验证临时文件用后即清——绿样本与红样本两条路径都不留 omni-rlvr-* 垃圾', async () => {
  const before = new Set(readdirSync(tmpdir()).filter((f) => f.startsWith('omni-rlvr-')));
  const verdictFor = verifiableVerdictForCode(() => VERIFY_COMMAND, {
    codeFileExtension: '.js',
  });
  const green = await verdictFor({ id: 't-green', code: GREEN_CODE });
  const red = await verdictFor({ id: 't-red', code: RED_CODE });
  assert.strictEqual(green.reward, 1, '绿 JS 代码经 node --check 应得满奖励');
  assert.strictEqual(red.reward, 0, '红 JS 代码经 node --check 应得零奖励');
  const after = readdirSync(tmpdir()).filter((f) => f.startsWith('omni-rlvr-'));
  const leaked = after.filter((f) => !before.has(f));
  assert.deepStrictEqual(leaked, [], '验证结束后不得遗留任何临时代码文件');
});

test('U4 桥：临时文件写入失败 → fail-closed 判 0（verifiable=false）且不留垃圾', async () => {
  const before = new Set(readdirSync(tmpdir()).filter((f) => f.startsWith('omni-rlvr-')));
  // 扩展名携带不存在的子目录段 → 拼出的临时路径必写失败（Windows/POSIX 一致），
  // 以此触发 write-error 分支，锁死「验证不可达 ≠ 假通过」的 fail-closed 语义。
  const verdictFor = verifiableVerdictForCode(() => VERIFY_COMMAND, {
    codeFileExtension: `no-such-dir-${Date.now()}/x.ts`,
  });
  const verdict = await verdictFor({ id: 't-unwritable', code: GREEN_CODE });
  assert.strictEqual(verdict.reward, 0, '写不进临时文件必须判 0');
  assert.strictEqual(verdict.verifiable, false, '写失败属「未能验证」而非「验证为红」');
  assert.ok(
    verdict.reason.startsWith('unverifiable:write-error'),
    `实际 reason: ${verdict.reason}`,
  );
  const after = readdirSync(tmpdir()).filter((f) => f.startsWith('omni-rlvr-'));
  const leaked = after.filter((f) => !before.has(f));
  assert.deepStrictEqual(leaked, [], '写失败路径同样不得遗留垃圾');
});
