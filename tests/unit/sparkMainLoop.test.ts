// 燧-3 共振寻址 / 燧-4 涡环包 接入主循环（F）：把已落地的端口+引擎封包进 createRuntime，
// 复用 I-P1-4 进化闭环的 autoRun 钩子范式，使"市面唯一"从端口变为真能力。断言：
//   ① 启用 resonance 后，注入 Agent 的 longTermMemory 即共振引擎，recall 走频率域代数（drop-in）；
//   ② 启用 vortexRing 后，注入的 spill 即涡环包适配器，外溢封成 vr_ 拓扑环、解环 fail-closed；
//   ③ SparkController 在配置层正确构造 / autoRun 门控；
//   ④ 任务完成后 autoRun 钩子真触发 燧-3 tune（证明钩子进主循环），且零破坏（关时不动）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { LongTermMemoryPort, MemoryFact } from '../../src/ports/memory/longTermMemory.js';
import { ResonantMemoryEngine } from '../../src/adapters/memory/resonantMemoryEngine.js';
import { VortexRingSpillAdapter } from '../../src/adapters/spill/vortexRingSpillAdapter.js';
import { SparkController } from '../../src/spark/sparkController.js';
import { Agent } from '../../src/core/agent.js';
import { createRuntime } from '../../src/core/runtime.js';
import { ConfigFactory } from '../../src/config/configFactory.js';
import { MemoryStorage } from '../../src/adapters/storage/memoryStorage.js';
import { AutoApproval } from '../../src/adapters/approval/autoApproval.js';
import { PassthroughSandbox } from '../../src/adapters/sandbox/passthroughSandbox.js';
import { SilentEventPort } from '../../src/adapters/event/silentEventPort.js';
import { ScriptedModel } from '../../src/eval/scriptedModel.js';

/** 测试用内存长期记忆桩（仅满足端口契约）。 */
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
    const f = this.facts.find((x) => x.id === id) as { importance: number } | undefined;
    if (f === undefined) return false;
    if (patch.importance !== undefined) f.importance = patch.importance;
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

// 三个主题，字符集互不重叠（杜绝跨主题共享字符，确保共振正交）。
const TOPIC_A = '调度 任务 夜间 坤';
const TOPIC_B = '预算 报表 戌期 乾';
const TOPIC_C = '登录 权限 账艮 艮';

function tmpWs(): string {
  return mkdtempSync(join(tmpdir(), 'omni-spark-'));
}

test('① 燧-3 接入主循环：注入的 longTermMemory 即共振引擎，recall 走频率域代数（drop-in）', () => {
  const base = new MemLongTermMemory();
  for (let i = 0; i < 3; i++) {
    base.remember(fact('A', TOPIC_A));
    base.remember(fact('B', TOPIC_B));
    base.remember(fact('C', TOPIC_C));
  }
  const config = ConfigFactory.build({
    workspaceRoot: tmpWs(),
    maxSteps: 8,
    model: new ScriptedModel([], '完成'),
    storage: new MemoryStorage(),
    approvals: new AutoApproval(),
    sandbox: new PassthroughSandbox(),
    events: new SilentEventPort(),
    longTermMemory: base,
    resonantField: { enabled: false },
    resonance: { enabled: true },
  });
  // 注入主循环的即共振引擎（而非原始 base）。
  assert.ok(
    config.longTermMemory instanceof ResonantMemoryEngine,
    'longTermMemory 应被封包成 ResonantMemoryEngine',
  );
  // recall 走共振：主题 A 探针 → top-3 全为 A（BM25 子串法对正交字符集会失准，共振代数不依赖子串）。
  // 注：必须在 mutate 之前召回，否则 delete 减少 A 事实数会使 top-3 无法全 A。
  const hits = config.longTermMemory.recall(TOPIC_A, 3);
  assert.strictEqual(hits.length, 3);
  assert.ok(
    hits.every((f) => f.topic === 'A'),
    '共振召回 top-3 应全是主题 A',
  );
  // drop-in：标准 LongTermMemoryPort 方法仍可用。
  assert.strictEqual(config.longTermMemory.count, 9);
  assert.strictEqual(config.longTermMemory.all().length, 9);
  assert.ok(config.longTermMemory.get('f0') !== undefined);
  assert.strictEqual(config.longTermMemory.update('f0', { importance: 5 }), true);
  assert.strictEqual(config.longTermMemory.get('f0')!.importance, 5);
  assert.strictEqual(config.longTermMemory.delete('f0'), true);
  assert.strictEqual(config.longTermMemory.count, 8);
});

test('② 燧-4 接入主循环：注入的 spill 即涡环包适配器，外溢封成 vr_ 拓扑环、解环 fail-closed', async () => {
  const config = ConfigFactory.build({
    workspaceRoot: tmpWs(),
    maxSteps: 8,
    model: new ScriptedModel([], '完成'),
    storage: new MemoryStorage(),
    approvals: new AutoApproval(),
    sandbox: new PassthroughSandbox(),
    events: new SilentEventPort(),
    vortexRing: { enabled: true },
    spillAdapter: 'memory',
    spillMaxInlineBytes: 1, // 任意输出都外溢，便于验证环包路径
  });
  assert.ok(
    config.spill instanceof VortexRingSpillAdapter,
    'spill 应被封包成 VortexRingSpillAdapter',
  );

  const BIG = 'x'.repeat(100);
  const handle = await config.spill.spill(BIG, 'sess');
  assert.ok(handle.id.startsWith('vr_'), '封环 id 应带 vr_ 前缀（拓扑环包）');
  const back = await config.spill.read(handle.id);
  assert.strictEqual(back, BIG, '解环应还原完整内容');
  const miss = await config.spill.read('vr_unknown_ring');
  assert.strictEqual(miss, undefined, '未知环包应 fail-closed 拒绝');

  // 经 spiller（stepRunner 实际使用的外溢器）路径：外溢文本携带 vr_ 环包定位符，且可解回。
  const stored = await config.spiller.apply(
    'shell',
    { callId: 'c1', ok: true, output: BIG },
    'sess',
  );
  const text = stored.output ?? stored.error ?? '';
  assert.ok(text.includes('spill://vr_'), 'spiller 外溢文本应含 vr_ 环包定位符');
  const idMatch = text.match(/spill:\/\/(vr_[A-Za-z0-9_]+)/);
  assert.ok(idMatch !== null, '应能解析出环包 id（仅含字母数字下划线，不含全角标点）');
  const back2 = await config.spill.read(idMatch![1]!);
  assert.strictEqual(back2, BIG, '经 spiller 封环的内容解环仍完整');
});

test('③ SparkController 装配与 autoRun 门控', async () => {
  const base = new MemLongTermMemory();
  const opts = {
    workspaceRoot: tmpWs(),
    maxSteps: 8,
    model: new ScriptedModel([], '完成'),
    storage: new MemoryStorage(),
    approvals: new AutoApproval(),
    sandbox: new PassthroughSandbox(),
    events: new SilentEventPort(),
    longTermMemory: base,
    resonantField: { enabled: false },
    resonance: { enabled: true },
    vortexRing: { enabled: true },
    spillAdapter: 'memory' as const,
  };

  // 两个都启用 + sparkAutoRun=true → 构造且 autoRun 开。
  const on = ConfigFactory.build({ ...opts, sparkAutoRun: true });
  assert.ok(on.spark instanceof SparkController, '任一燧能力启用时应构造 SparkController');
  assert.strictEqual(on.spark!.autoRun, true);
  assert.ok(on.longTermMemory instanceof ResonantMemoryEngine);
  assert.ok(on.spill instanceof VortexRingSpillAdapter);

  // 两个都启用但无 autoRun → autoRun 默认关（零破坏旁路）。
  const off = ConfigFactory.build({ ...opts });
  assert.ok(off.spark instanceof SparkController);
  assert.strictEqual(off.spark!.autoRun, false);

  // 都不启用 → 不构造（零侵入）。
  const none = ConfigFactory.build({ ...opts, resonance: undefined, vortexRing: undefined });
  assert.strictEqual(none.spark, undefined, '无燧能力时不应构造 SparkController');

  // cycle() 报告两个维度。
  const report = await on.spark!.cycle();
  assert.strictEqual(report.ran, true);
  assert.ok(report.resonance !== undefined, '应含燧-3 调谐结果');
  assert.ok(report.vortex !== undefined, '应含燧-4 冲刷结果');
});

test('④ autoRun 钩子真进主循环：任务完成后触发 燧-3 tune（关时零破坏）', async () => {
  const base = new MemLongTermMemory();
  base.remember(fact('A', TOPIC_A));

  // 启用 + autoRun：运行 Agent，断言任务完成且任务末调用了 resonance.tune()。
  const configOn = ConfigFactory.build({
    workspaceRoot: tmpWs(),
    maxSteps: 16,
    model: new ScriptedModel([], '共振完成'),
    storage: new MemoryStorage(),
    approvals: new AutoApproval(),
    sandbox: new PassthroughSandbox(),
    events: new SilentEventPort(),
    longTermMemory: base,
    resonance: { enabled: true },
    sparkAutoRun: true,
  });
  const engineOn = configOn.longTermMemory as ResonantMemoryEngine;
  let tuned = false;
  const realTune = engineOn.tune.bind(engineOn);
  engineOn.tune = () => {
    tuned = true;
    return realTune();
  };
  const agentOn = new Agent(createRuntime(configOn));
  const resOn = await agentOn.runTask('做点事');
  assert.ok(resOn.finalText?.includes('共振完成'), '主任务应正常完成');
  assert.ok(tuned, 'spark autoRun 应在任务末调用 resonance.tune()（钩子真进主循环）');

  // 零破坏：未启用 spark 时，Agent 跑完不触发任何 燧 调谐（且行为正常）。
  const base2 = new MemLongTermMemory();
  const configOff = ConfigFactory.build({
    workspaceRoot: tmpWs(),
    maxSteps: 16,
    model: new ScriptedModel([], '正常完成'),
    storage: new MemoryStorage(),
    approvals: new AutoApproval(),
    sandbox: new PassthroughSandbox(),
    events: new SilentEventPort(),
    longTermMemory: base2,
    resonance: { enabled: true }, // 启用了共振，但没开 sparkAutoRun
  });
  const engineOff = configOff.longTermMemory as ResonantMemoryEngine;
  let tunedOff = false;
  const realTuneOff = engineOff.tune.bind(engineOff);
  engineOff.tune = () => {
    tunedOff = true;
    return realTuneOff();
  };
  const agentOff = new Agent(createRuntime(configOff));
  const resOff = await agentOff.runTask('做点事');
  assert.ok(resOff.finalText?.includes('正常完成'));
  assert.strictEqual(tunedOff, false, '未开 sparkAutoRun 时不应触发 燧 调谐（零破坏）');
});
