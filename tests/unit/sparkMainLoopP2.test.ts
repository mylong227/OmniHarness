// (P2) 信念支柱接入主循环：复用 I-P1-4 进化闭环的 autoRun 钩子，使自然梯度/粒子滤波信念从端口
// 变为主循环里真跑的能力。断言：
//   ① belief=both 启用 → 构造 spark + 两类信念引擎，cycle 报告 belief 两维度（KL 有限）；
//   ② 仅粒子滤波算法 → 仅 particleFilter 构造，naturalGradient 未构造；
//   ③ 未启用信念（且无其他燧能力）→ spark 不构造（零破坏旁路）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { LongTermMemoryPort, MemoryFact } from '../../src/ports/longTermMemory.js';
import { SparkController } from '../../src/spark/sparkController.js';
import { NaturalGradientBelief } from '../../src/adapters/belief/naturalGradientBelief.js';
import { ParticleFilterBelief } from '../../src/adapters/belief/particleFilterBelief.js';
import { ConfigFactory } from '../../src/config/configFactory.js';
import { MemoryStorage } from '../../src/adapters/storage/memoryStorage.js';
import { AutoApproval } from '../../src/adapters/approval/autoApproval.js';
import { PassthroughSandbox } from '../../src/adapters/sandbox/passthroughSandbox.js';
import { SilentEventPort } from '../../src/adapters/event/silentEventPort.js';
import { ScriptedModel } from '../../src/eval/scriptedModel.js';

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

function tmpWs(): string {
  return mkdtempSync(join(tmpdir(), 'omni-p2-'));
}

test('① belief=both 启用 → 构造 spark + 两类信念引擎，cycle 报告 belief 两维度', async () => {
  const mem = new MemLongTermMemory();
  const config = ConfigFactory.build({
    workspaceRoot: tmpWs(),
    maxSteps: 8,
    model: new ScriptedModel([], '信念完成'),
    storage: new MemoryStorage(),
    approvals: new AutoApproval(),
    sandbox: new PassthroughSandbox(),
    events: new SilentEventPort(),
    longTermMemory: mem,
    belief: { enabled: true, algorithm: 'both' },
    sparkAutoRun: true,
  });
  assert.ok(config.spark instanceof SparkController, 'belief 启用时应构造 SparkController');
  assert.ok(config.naturalGradient instanceof NaturalGradientBelief, '应注入自然梯度信念');
  assert.ok(config.particleFilter instanceof ParticleFilterBelief, '应注入粒子滤波信念');

  const rep = await config.spark!.cycle();
  assert.strictEqual(rep.ran, true);
  assert.ok(rep.belief?.naturalGradient !== undefined, '应含自然梯度信念维度');
  assert.ok(rep.belief?.particleFilter !== undefined, '应含粒子滤波信念维度');
  assert.ok(isFinite(rep.belief!.naturalGradient!.kl.total), '自然梯度 KL 应有限');
  assert.ok(isFinite(rep.belief!.particleFilter!.kl.total), '粒子滤波 KL 应有限');
});

test('② 仅粒子滤波算法 → 仅 particleFilter 构造，naturalGradient 未构造', () => {
  const mem = new MemLongTermMemory();
  const config = ConfigFactory.build({
    workspaceRoot: tmpWs(),
    maxSteps: 8,
    model: new ScriptedModel([], '信念PF'),
    storage: new MemoryStorage(),
    approvals: new AutoApproval(),
    sandbox: new PassthroughSandbox(),
    events: new SilentEventPort(),
    longTermMemory: mem,
    belief: { enabled: true, algorithm: 'particle-filter' },
  });
  assert.ok(config.particleFilter instanceof ParticleFilterBelief, '应注入粒子滤波信念');
  assert.strictEqual(config.naturalGradient, undefined, '自然梯度不应构造');
});

test('③ 未启用信念（且无其他燧能力）→ spark 不构造（零破坏）', () => {
  const mem = new MemLongTermMemory();
  const config = ConfigFactory.build({
    workspaceRoot: tmpWs(),
    maxSteps: 8,
    model: new ScriptedModel([], '无信念'),
    storage: new MemoryStorage(),
    approvals: new AutoApproval(),
    sandbox: new PassthroughSandbox(),
    events: new SilentEventPort(),
    longTermMemory: mem,
    resonantField: { enabled: false },
  });
  assert.strictEqual(config.spark, undefined, '无活跃燧能力时不应构造 spark');
});
