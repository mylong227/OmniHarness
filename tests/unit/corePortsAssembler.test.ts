import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assembleCorePorts } from '../../src/config/corePortsAssembler.js';
import { MockModel } from '../../src/adapters/model/mockModel.js';
import { MemoryStorage } from '../../src/adapters/storage/memoryStorage.js';
import { SilentEventPort } from '../../src/adapters/event/silentEventPort.js';
import { PassthroughSandbox } from '../../src/adapters/sandbox/passthroughSandbox.js';
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

/** 在临时工作区内跑断言，结束后清理。 */
function withWorkspace<T>(fn: (root: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), 'cfg-core-'));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('基础设施端口：缺省落 fail-closed 最保守实现', () => {
  withWorkspace((root) => {
    const { ports, vortex } = assembleCorePorts(base(root));
    assert.strictEqual(ports.sandbox.name, 'passthrough');
    assert.strictEqual(ports.approvals.name, 'auto');
    // 提权复核沙箱默认 policy（收紧），而非 passthrough 全放行。
    assert.strictEqual(ports.elevatedSandbox.name, 'policy');
    assert.strictEqual(ports.escalation.name, 'deny');
    assert.strictEqual(ports.retrieval.name, 'bm25-memory');
    assert.strictEqual(ports.events.name, 'console');
    assert.strictEqual(ports.planMode, false);
    assert.strictEqual(ports.turnDiff, true);
    assert.ok(ports.turnDiffTracker !== undefined, '变更追踪默认开');
    assert.ok(ports.hooks !== undefined, '变更追踪开启时应装配钩子运行器');
    assert.strictEqual(vortex, undefined, '未启用涡环包时无适配器');
  });
});

test('基础设施端口：外溢按 spillAdapter 选择内置后端', () => {
  withWorkspace((root) => {
    assert.strictEqual(assembleCorePorts(base(root)).ports.spill.name, 'file');
    assert.strictEqual(
      assembleCorePorts(base(root, { spillAdapter: 'memory' })).ports.spill.name,
      'memory',
    );
  });
});

test('基础设施端口：turnDiff=false 时不追踪也不产钩子', () => {
  withWorkspace((root) => {
    const { ports } = assembleCorePorts(base(root, { turnDiff: false }));
    assert.strictEqual(ports.turnDiff, false);
    assert.strictEqual(ports.turnDiffTracker, undefined);
    assert.strictEqual(ports.hooks, undefined);
  });
});

test('基础设施端口：approvalCache 开启时审批端口包缓存层', () => {
  withWorkspace((root) => {
    const off = assembleCorePorts(base(root)).ports.approvals;
    const on = assembleCorePorts(base(root, { approvalCache: true })).ports.approvals;
    assert.strictEqual(off.name, 'auto');
    assert.strictEqual(on.name, 'cached');
  });
});

test('基础设施端口：用户注入端口原样保留（不覆盖）', () => {
  withWorkspace((root) => {
    const events = new SilentEventPort();
    const sandbox = new PassthroughSandbox();
    const { ports } = assembleCorePorts(base(root, { events, sandbox }));
    assert.strictEqual(ports.events, events);
    assert.strictEqual(ports.sandbox, sandbox);
  });
});

test('基础设施端口：涡环包开启时外溢端口被其替换且适配器外露', () => {
  withWorkspace((root) => {
    const { ports, vortex } = assembleCorePorts(base(root, { vortexRing: { enabled: true } }));
    assert.ok(vortex !== undefined, '启用后应有涡环包适配器');
    // 主循环的全部"超大输出外溢"须走拓扑环包，故外溢端口即适配器本身。
    assert.strictEqual(ports.spill, vortex);
  });
});
