// U1 验收（resonantField 默认开启）：默认配置下，长期记忆/共振/宇宙网三态合一于
// 单一 ResonantFieldEngine 实例（消除双重频谱索引），且 SparkController 能在同一引擎上
// 同时驱动 燧-3 tune 与宇宙网 consolidate 而不双实例化、不崩。
//
// 这是「全局记忆行为变更」的验收闸门：翻默认前必须证明单一状态源真的收敛。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConfigFactory } from '../../src/config/configFactory.js';
import { createRuntime } from '../../src/composition/runtime.js';
import { MemoryStorage } from '../../src/adapters/storage/memoryStorage.js';
import { AutoApproval } from '../../src/adapters/approval/autoApproval.js';
import { PassthroughSandbox } from '../../src/adapters/sandbox/passthroughSandbox.js';
import { SilentEventPort } from '../../src/adapters/event/silentEventPort.js';
import { ScriptedModel } from '../../src/eval/scriptedModel.js';
import { ResonantFieldEngine } from '../../src/adapters/memory/resonantFieldEngine.js';

function buildDefaultRuntime() {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'omni-u1-accept-'));
  const config = ConfigFactory.build({
    workspaceRoot,
    maxSteps: 4,
    model: new ScriptedModel([], 'done'),
    storage: new MemoryStorage(),
    approvals: new AutoApproval(),
    sandbox: new PassthroughSandbox(),
    events: new SilentEventPort(),
  });
  // supervisor 缺省 → createRuntime 自动构造生产级 SupervisorKernel
  return createRuntime(config);
}

test('U1 默认开启：默认配置下长期记忆是单一 ResonantFieldEngine 实例', () => {
  const runtime = buildDefaultRuntime();
  assert.ok(
    runtime.longTermMemory instanceof ResonantFieldEngine,
    '默认配置下 longTermMemory 应 instanceof ResonantFieldEngine（而非旧双引擎封包）',
  );
});

test('U1 单一状态源：runtime.web 与 runtime.longTermMemory 同一实例（双重频谱索引消除）', () => {
  const runtime = buildDefaultRuntime();
  assert.ok(runtime.web !== undefined, 'runtime.web（宇宙网端口）应已接线');
  assert.strictEqual(
    runtime.web,
    runtime.longTermMemory,
    'runtime.web 应与 runtime.longTermMemory 同一实例：共振+宇宙网未双实例化，单一状态源',
  );
});

test('U1 收敛：spark.cycle 在单一引擎上同时驱动 tune 与 consolidate 且不崩', async () => {
  const runtime = buildDefaultRuntime();
  assert.ok(runtime.spark, 'spark 应存在（resonanceEngine/webEngine 已设）');

  const report = await runtime.spark!.cycle();
  assert.strictEqual(report.ran, true, 'spark.cycle 应 ran=true');
  // 燧-3 tune 真实运行于单一引擎（resonance 端口）
  assert.ok(
    report.resonance && typeof report.resonance.clusters === 'number',
    'report.resonance.clusters 应为数字：tune() 在单一引擎上真实运行',
  );
  // 宇宙网 consolidate 真实运行于同一引擎（web 端口）
  assert.ok(
    report.web && typeof report.web.nodes === 'number',
    'report.web.nodes 应为数字：consolidate() 在单一引擎上真实运行',
  );
});

test('U1 收敛：写入事实经单一存储不翻倍、可被召回', async () => {
  const runtime = buildDefaultRuntime();
  const before = runtime.longTermMemory.count;

  runtime.longTermMemory.remember({
    id: 'fact-u1-accept-1',
    text: 'OmniHarness 是融合 Codex 与 DeepSeek Harness 的全能 Agent Harness',
    topic: 'project',
    importance: 5,
    createdAt: new Date().toISOString(),
    sessionId: 'sess-u1',
    source: 'tool',
  });
  assert.strictEqual(runtime.longTermMemory.count, before + 1, '写入后长期记忆事实数 +1');

  // 跑一轮 spark（tune + consolidate 都作用于同一引擎）
  const report = await runtime.spark!.cycle();
  assert.strictEqual(report.ran, true);

  // 关键不变量：单一状态源 → 事实不会因双引擎封包而翻倍
  assert.strictEqual(
    runtime.longTermMemory.count,
    before + 1,
    'cycle 后事实数仍为 +1（未双实例化导致翻倍）',
  );
  // 单一状态源真的存住了：写入的事实可被 recall 召回
  const recalled = runtime.longTermMemory.recall('OmniHarness 全能 Agent Harness', 3);
  assert.ok(
    recalled.some((f) => f.id === 'fact-u1-accept-1'),
    '写入的事实应可被 recall 召回（单一状态源存住）',
  );
});
