import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assembleMemoryStack } from '../../src/config/memoryStackAssembler.js';
import { MockModel } from '../../src/adapters/model/mockModel.js';
import { MemoryStorage } from '../../src/adapters/storage/memoryStorage.js';
import type { LongTermMemoryPort, MemoryFact, MemoryFactPatch } from '../../src/ports/longTermMemory.js';
import type { OmniHarnessConfig } from '../../src/config/omniharnessConfig.js';

/** 最小长期记忆桩：内存数组 + 固定标识（用于验证「注入优先」）。 */
class StubMemory implements LongTermMemoryPort {
  public readonly name = 'stub-memory';
  private readonly facts: MemoryFact[] = [];

  public remember(fact: MemoryFact): void {
    this.facts.push(fact);
  }

  public recall(_query: string, _k: number): readonly MemoryFact[] {
    return this.facts;
  }

  public all(): readonly MemoryFact[] {
    return this.facts;
  }

  public get count(): number {
    return this.facts.length;
  }

  public get(id: string): MemoryFact | undefined {
    return this.facts.find((fact) => fact.id === id);
  }

  public update(_id: string, _patch: MemoryFactPatch): boolean {
    return false;
  }

  public delete(_id: string): boolean {
    return false;
  }
}

/** 构造最小可解析配置（mock 适配器，无网络）。 */
function base(root: string, over: Partial<OmniHarnessConfig> = {}): OmniHarnessConfig {
  return {
    workspaceRoot: root,
    maxSteps: 4,
    model: new MockModel(),
    storage: new MemoryStorage(),
    ...over,
  };
}

/** 在临时工作区内跑断言，结束后清理。 */
function withWorkspace<T>(fn: (root: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), 'cfg-mem-'));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('MemoryStackAssembler：缺省开统一基板——长期记忆/宇宙网/共振三态同一实例', () => {
  withWorkspace((root) => {
    const { stack, sparkInput } = assembleMemoryStack(base(root), undefined);
    assert.strictEqual(stack.longTermMemory.name, 'resonant-field');
    // 单一状态源：RG 坍缩与调谐必须作用在同一实例上，否则双重频谱索引会各自漂移。
    assert.strictEqual(stack.web, stack.longTermMemory);
    assert.strictEqual(sparkInput.resonance, stack.longTermMemory);
  });
});

test('MemoryStackAssembler：显式关统一基板后回落到基础文件存储', () => {
  withWorkspace((root) => {
    const { stack, sparkInput } = assembleMemoryStack(
      base(root, { resonantField: { enabled: false } }),
      undefined,
    );
    assert.strictEqual(stack.longTermMemory.name, 'file-longterm');
    assert.strictEqual(stack.web, undefined);
    assert.strictEqual(sparkInput.resonance, undefined);
  });
});

test('MemoryStackAssembler：分别启用宇宙网 / 共振时按序封包', () => {
  withWorkspace((root) => {
    const webOnly = assembleMemoryStack(
      base(root, { resonantField: { enabled: false }, memoryWeb: { enabled: true } }),
      undefined,
    );
    assert.strictEqual(webOnly.stack.web?.name, 'cosmic-web-memory');
    assert.strictEqual(webOnly.stack.longTermMemory, webOnly.stack.web);

    const resOnly = assembleMemoryStack(
      base(root, { resonantField: { enabled: false }, resonance: { enabled: true } }),
      undefined,
    );
    assert.strictEqual(resOnly.stack.longTermMemory.name, 'resonant-memory');
    assert.strictEqual(resOnly.sparkInput.resonance, resOnly.stack.longTermMemory);
    assert.strictEqual(resOnly.stack.web, undefined);
  });
});

test('MemoryStackAssembler：注入自定义长期记忆优先于内置文件存储', () => {
  withWorkspace((root) => {
    const custom = new StubMemory();
    const { stack } = assembleMemoryStack(
      base(root, { longTermMemory: custom, resonantField: { enabled: false } }),
      undefined,
    );
    assert.strictEqual(stack.longTermMemory, custom);
  });
});

test('MemoryStackAssembler：蒸馏器仅在「有模型 + 未关自动沉淀」时构造', () => {
  withWorkspace((root) => {
    const noModel = assembleMemoryStack(base(root), undefined);
    assert.strictEqual(noModel.stack.memoryExtractor, undefined);

    const withModel = assembleMemoryStack(base(root), new MockModel());
    assert.ok(withModel.stack.memoryExtractor !== undefined);

    const off = assembleMemoryStack(base(root, { memoryConsolidate: false }), new MockModel());
    assert.strictEqual(off.stack.memoryExtractor, undefined);
  });
});

test('MemoryStackAssembler：退火 / QEC / 免疫按开关构造', () => {
  withWorkspace((root) => {
    const off = assembleMemoryStack(base(root), undefined);
    assert.strictEqual(off.stack.annealer, undefined);
    assert.strictEqual(off.stack.qecEncoder, undefined);
    assert.strictEqual(off.stack.immune, undefined);
    assert.strictEqual(off.sparkInput.immuneSample, undefined);

    const on = assembleMemoryStack(
      base(root, {
        memoryAnnealing: { enabled: true },
        qec: { enabled: true },
        immuneMonitoring: { enabled: true },
      }),
      undefined,
    );
    assert.ok(on.stack.annealer !== undefined);
    assert.ok(on.stack.qecEncoder !== undefined);
    assert.ok(on.stack.immune !== undefined);
    assert.ok(on.sparkInput.immuneSample !== undefined);
  });
});

test('MemoryStackAssembler：信念按 algorithm 分派引擎与采样器', () => {
  withWorkspace((root) => {
    const none = assembleMemoryStack(base(root), undefined);
    assert.strictEqual(none.stack.naturalGradient, undefined);
    assert.strictEqual(none.stack.particleFilter, undefined);
    assert.strictEqual(none.sparkInput.beliefObservation, undefined);

    const ng = assembleMemoryStack(
      base(root, { belief: { enabled: true, algorithm: 'natural-gradient' } }),
      undefined,
    );
    assert.ok(ng.stack.naturalGradient !== undefined);
    assert.strictEqual(ng.stack.particleFilter, undefined);

    const both = assembleMemoryStack(base(root, { belief: { enabled: true } }), undefined);
    assert.ok(both.stack.naturalGradient !== undefined);
    assert.ok(both.stack.particleFilter !== undefined);
    assert.ok(both.sparkInput.beliefObservation !== undefined);
  });
});

test('MemoryStackAssembler：免疫采样器对空记忆返回全零三维向量', () => {
  withWorkspace((root) => {
    const { sparkInput } = assembleMemoryStack(
      base(root, { immuneMonitoring: { enabled: true } }),
      undefined,
    );
    const sample = sparkInput.immuneSample;
    assert.ok(sample !== undefined);
    assert.deepStrictEqual([...sample()], [0, 0, 0]);
  });
});
