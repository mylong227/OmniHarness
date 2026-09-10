// (E) 宇宙网记忆 / QEC / 免疫监控 接入主循环：复用 I-P1-4 进化闭环的 autoRun 钩子，使三个
// 发明层算子从端口变为主循环里真跑的能力。断言：
//   ① 同时启用 memoryWeb/qec/immuneMonitoring → 构造 spark + 三个算子，cycle 报告三维度；
//   ② 主循环 QEC 阶段真纠正单点损坏（非空转）；
//   ③ 仅启用免疫监控也构造 spark（证明三算子各自独立触发接线），cycle 报告 immune 维度。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { LongTermMemoryPort, MemoryFact } from '../../src/ports/longTermMemory.js';
import { SparkController } from '../../src/spark/sparkController.js';
import { CosmicWebMemoryEngine } from '../../src/adapters/memory/cosmicWeb.js';
import { QECEncoder } from '../../src/adapters/memory/qec.js';
import { ImmuneMonitor } from '../../src/adapters/monitoring/immuneMonitor.js';
import { ConfigFactory } from '../../src/config/omniharnessConfig.js';
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

let seq = 0;
function fact(id: string, text: string): MemoryFact {
  return {
    id,
    text,
    importance: 3,
    createdAt: new Date().toISOString(),
    sessionId: 's1',
    source: 'tool',
  };
}

function tmpWs(): string {
  return mkdtempSync(join(tmpdir(), 'omni-e-'));
}

test('① 三算子同时启用 → 构造 spark + 各算子，cycle 报告 web/qec/immune', async () => {
  const mem = new MemLongTermMemory();
  const config = ConfigFactory.build({
    workspaceRoot: tmpWs(),
    maxSteps: 8,
    model: new ScriptedModel([], '宇宙网完成'),
    storage: new MemoryStorage(),
    approvals: new AutoApproval(),
    sandbox: new PassthroughSandbox(),
    events: new SilentEventPort(),
    longTermMemory: mem,
    resonantField: { enabled: false },
    memoryWeb: { enabled: true, bekensteinCap: 4 },
    qec: { enabled: true },
    immuneMonitoring: { enabled: true },
    sparkAutoRun: true,
  });
  assert.ok(config.spark instanceof SparkController, '三算子启用时应构造 SparkController');
  assert.ok(config.web instanceof CosmicWebMemoryEngine, '应注入宇宙网引擎');
  assert.ok(config.qecEncoder instanceof QECEncoder, '应注入 QEC 编码器');
  assert.ok(config.immune instanceof ImmuneMonitor, '应注入免疫监控器');

  const rep = await config.spark!.cycle();
  assert.strictEqual(rep.ran, true);
  assert.ok(rep.web !== undefined, '应含宇宙网维度');
  assert.ok(rep.qec !== undefined, '应含 QEC 维度');
  assert.ok(rep.immune !== undefined, '应含免疫维度');
});

test('② 主循环 QEC 阶段真纠正单点损坏（非静默）', async () => {
  const mem = new MemLongTermMemory();
  const config = ConfigFactory.build({
    workspaceRoot: tmpWs(),
    maxSteps: 8,
    model: new ScriptedModel([], 'QEC 完成'),
    storage: new MemoryStorage(),
    approvals: new AutoApproval(),
    sandbox: new PassthroughSandbox(),
    events: new SilentEventPort(),
    longTermMemory: mem,
    qec: { enabled: true },
    sparkAutoRun: true,
  });
  // 经（可能封包的）长期记忆写入并编码。
  config.longTermMemory.remember(fact('fx', 'hello world'));
  config.qecEncoder!.encode('fx');
  // 注入单点损坏。
  mem.update('fx', { text: 'hellx world' });
  const rep = await config.spark!.cycle();
  assert.ok(rep.qec !== undefined);
  assert.ok(rep.qec!.corrected >= 1, '主循环 QEC 阶段应纠正单点损坏');
  assert.strictEqual(mem.get('fx')!.text, 'hello world', '损坏应被主循环修复复原');
});

test('③ 仅启用免疫监控也构造 spark（三算子各自独立触发接线）', () => {
  const mem = new MemLongTermMemory();
  const config = ConfigFactory.build({
    workspaceRoot: tmpWs(),
    maxSteps: 8,
    model: new ScriptedModel([], '免疫完成'),
    storage: new MemoryStorage(),
    approvals: new AutoApproval(),
    sandbox: new PassthroughSandbox(),
    events: new SilentEventPort(),
    longTermMemory: mem,
    resonantField: { enabled: false },
    immuneMonitoring: { enabled: true },
  });
  assert.ok(config.spark instanceof SparkController, '仅免疫也应构造 spark');
  assert.ok(config.immune instanceof ImmuneMonitor);
  assert.ok(config.web === undefined && config.qecEncoder === undefined, '其余算子应未构造');
});
