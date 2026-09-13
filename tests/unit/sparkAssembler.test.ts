import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assembleSpark } from '../../src/config/sparkAssembler.js';
import { assembleMemoryStack } from '../../src/config/memoryStackAssembler.js';
import { assembleSkillStack } from '../../src/config/skillStackAssembler.js';
import { MockModel } from '../../src/adapters/model/mockModel.js';
import { MemoryStorage } from '../../src/adapters/storage/memoryStorage.js';
import { JsonlRuntimeTelemetry } from '../../src/adapters/telemetry/jsonlRuntimeTelemetry.js';
import {
  VortexRingPacket,
  VortexRingSpillAdapter,
} from '../../src/adapters/spill/vortexRingSpillAdapter.js';
import { MemorySpill } from '../../src/adapters/spill/memorySpill.js';
import type { OmniHarnessConfig } from '../../src/config/configFactory.js';

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

/** 由配置装配三栈并跑燧内核装配。 */
function assemble(root: string, over: Partial<OmniHarnessConfig> = {}) {
  const partial = base(root, over);
  return assembleSpark(partial, {
    vortex: undefined,
    memory: assembleMemoryStack(partial, undefined),
    skills: assembleSkillStack(partial),
  });
}

/** 在临时工作区内跑断言，结束后清理。 */
function withWorkspace<T>(fn: (root: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), 'cfg-spark-'));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('SparkAssembler：无活跃燧能力时不构造控制器（零开销旁路）', () => {
  withWorkspace((root) => {
    // 统一基板会启用共振寻址，故须显式关掉才可得到"全旁路"基线。
    assert.strictEqual(assemble(root, { resonantField: { enabled: false } }), undefined);
  });
});

test('SparkAssembler：统一基板默认开启即视为活跃燧能力', () => {
  withWorkspace((root) => {
    assert.ok(assemble(root) !== undefined);
  });
});

test('SparkAssembler：分别启用共振 / 刻蚀 / 遥测即活跃', () => {
  withWorkspace((root) => {
    assert.ok(
      assemble(root, { resonantField: { enabled: false }, resonance: { enabled: true } }) !==
        undefined,
    );
    assert.ok(
      assemble(root, { resonantField: { enabled: false }, insightEtching: { enabled: true } }) !==
        undefined,
    );
    const telemetry = new JsonlRuntimeTelemetry({ path: join(root, 'runtime-telemetry.log') });
    assert.ok(
      assemble(root, { resonantField: { enabled: false }, runtimeTelemetry: telemetry }) !==
        undefined,
    );
  });
});

test('SparkAssembler：涡环包适配器经输入注入即活跃', () => {
  withWorkspace((root) => {
    const partial = base(root, { resonantField: { enabled: false } });
    const skillStack = assembleSkillStack(partial);
    const memory = assembleMemoryStack(partial, undefined);
    // 涡环包由 CorePortsAssembler 产出，此处以真实适配器验证「存在即活跃」。
    const vortex = new VortexRingSpillAdapter(new VortexRingPacket(new MemorySpill()));
    const spark = assembleSpark(partial, { vortex, memory, skills: skillStack });
    assert.ok(spark !== undefined);
  });
});
