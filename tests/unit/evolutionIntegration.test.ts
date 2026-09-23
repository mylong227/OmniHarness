// 进化闭环端到端集成测试（P1 首发块的核心主张：发明层原语真进 createRuntime 真实循环做 A/B）。
// 把 EvolutionController 注入 Agent（autoRun 开启），跑一个真实任务，断言：
//   ① 任务正常完成、主流程不报错；
//   ② 任务完成后自动跑一轮 发现→评估→晋升；
//   ③ 达标组合技能被晋升进实时 SkillRegistry（即"燧-1 真正进入循环"）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Skill } from '../../src/skill/skill.js';
import { composeByTwist } from '../../src/skill/moireComposer.js';
import { moireEnergy } from '../../src/evolution/benchmark.js';
import { FailClosedEvolutionGate } from '../../src/evolution/failClosedEvolutionGate.js';
import { TwistDiscoveryEngine } from '../../src/evolution/twistDiscoveryEngine.js';
import { EvolutionControllerImpl } from '../../src/evolution/evolutionControllerImpl.js';
import { Agent } from '../../src/core/agent.js';
import { createRuntime } from '../../src/composition/runtime.js';
import { ConfigFactory } from '../../src/config/configFactory.js';
import { MemoryStorage } from '../../src/adapters/storage/memoryStorage.js';
import { AutoApproval } from '../../src/adapters/approval/autoApproval.js';
import { PassthroughSandbox } from '../../src/adapters/sandbox/passthroughSandbox.js';
import { SilentEventPort } from '../../src/adapters/event/silentEventPort.js';
import { ScriptedModel } from '../../src/eval/scriptedModel.js';
import { SkillRegistry } from '../../src/skill/skillRegistry.js';

const N = 64;

function baseSkill(name: string, topic: string): Skill {
  return {
    name,
    description: `${topic} 相关能力`,
    instructions: `执行 ${topic} 任务的具体步骤。`,
    tags: [topic],
  };
}

test('端到端：evolution 注入 Agent 后，任务完成跑闭环并把达标组合技能晋升进实时注册表', async () => {
  const A = baseSkill('skill-a', '检索');
  const B = baseSkill('skill-b', '推理');
  const registry = new SkillRegistry();
  registry.register(A);
  registry.register(B);

  const gate = new FailClosedEvolutionGate({
    benchmark: (c) => moireEnergy(c.skill, N),
    baseline: Math.max(moireEnergy(A, N), moireEnergy(B, N)),
    minGain: 0.05,
  });
  const controller = new EvolutionControllerImpl({
    discovery: new TwistDiscoveryEngine({
      skills: [A, B],
      compose: (a, b) => composeByTwist(a, b),
      maxCandidates: 4,
    }),
    gate,
    // 晋升回调：达标组合技能注册进实时技能注册表（即"进入循环"）。
    onPromote: (c) => {
      try {
        registry.register(c.skill);
      } catch {
        /* 重名忽略 */
      }
    },
    autoRun: true,
  });

  const workspaceRoot = mkdtempSync(join(tmpdir(), 'omni-evoint-'));
  const config = ConfigFactory.build({
    workspaceRoot,
    maxSteps: 16,
    model: new ScriptedModel([], '任务完成'),
    storage: new MemoryStorage(),
    approvals: new AutoApproval(),
    sandbox: new PassthroughSandbox(),
    events: new SilentEventPort(),
    evolution: controller,
  });
  const agent = new Agent(createRuntime(config), registry);

  const result = await agent.runTask('做点事');
  assert.ok(result.finalText?.includes('任务完成'), '主任务应正常完成');

  // 闭环已跑且达标组合技能被晋升进实时注册表（证明燧-1 真正进入循环做 A/B）。
  assert.ok(registry.get('moire:skill-a+skill-b') !== undefined, '组合技能应被晋升进实时注册表');
  assert.strictEqual(controller.budgetUsed().generated, 1);
});

test('零破坏：未注入 evolution 时 Agent 行为与以往一致（不跑闭环）', async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'omni-evoint2-'));
  const config = ConfigFactory.build({
    workspaceRoot,
    maxSteps: 16,
    model: new ScriptedModel([], '正常完成'),
    storage: new MemoryStorage(),
    approvals: new AutoApproval(),
    sandbox: new PassthroughSandbox(),
    events: new SilentEventPort(),
  });
  const agent = new Agent(createRuntime(config));
  const result = await agent.runTask('做点事');
  assert.ok(result.finalText?.includes('正常完成'));
  assert.strictEqual(config.evolution, undefined);
});
