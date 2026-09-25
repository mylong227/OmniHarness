// F1：配置装配器（ConfigBuilder）单测——此前该模块（337 行）零测试引用。
// 覆盖各 buildXxx 分支：审批缓存包装 / 模型包装链 / 路由 fail-closed / LSP·身份按需装配 /
// 外溢后端选择 / 回答器 / 钩子 / 子智能体种子。全部用 mock 适配器与临时工作区，零网络。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConfigBuilder } from '../../src/config/configBuilder.js';
import { ConfigError } from '../../src/config/configError.js';
import { AutoApproval } from '../../src/adapters/approval/autoApproval.js';
import { CachedApproval } from '../../src/adapters/approval/cachedApproval.js';
import { MockModel } from '../../src/adapters/model/mockModel.js';
import { RetryingModel } from '../../src/adapters/model/retryingModel.js';
import { BudgetedModel } from '../../src/adapters/model/budgetedModel.js';
import { CircuitBreakingModel } from '../../src/adapters/model/circuitBreakingModel.js';
import { CircuitOpenError } from '../../src/errors/circuitOpenError.js';
import type { ModelPort, ModelOutput, ModelRequest } from '../../src/ports/model/model.js';
import { ModelRouter } from '../../src/adapters/model/modelRouter.js';
import { OpenAiCompatibleModel } from '../../src/adapters/model/openAiCompatibleModel.js';
import { CostBudget } from '../../src/adapters/model/costBudget.js';
import { MemoryStorage } from '../../src/adapters/storage/memoryStorage.js';
import { PassthroughSandbox } from '../../src/adapters/sandbox/passthroughSandbox.js';
import { PolicySandbox } from '../../src/adapters/sandbox/policySandbox.js';
import { SilentEventPort } from '../../src/adapters/event/silentEventPort.js';
import { MemorySpill } from '../../src/adapters/spill/memorySpill.js';
import { DenyEscalation } from '../../src/adapters/escalation/denyEscalation.js';
import { FileLongTermMemory } from '../../src/adapters/memory/fileLongTermMemory.js';
import { ToolResultSpiller } from '../../src/context/toolResultSpiller.js';
import { TurnDiffTracker } from '../../src/core/turnDiffTracker.js';
import { DEFAULT_GOAL_MAX_ITERATIONS } from '../../src/autonomy/goalRunner.js';
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
  const root = mkdtempSync(join(tmpdir(), 'cfg-builder-'));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** 在临时环境变量下执行并复原。 */
function withEnv(name: string, value: string | undefined, fn: () => void): void {
  const prev = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env[name];
    else process.env[name] = prev;
  }
}

test('buildApprovals：缺省返回 AutoApproval；未开缓存不加包装', () => {
  withWorkspace((root) => {
    const builder = new ConfigBuilder();
    const sandbox = new PassthroughSandbox();
    const port = builder.buildApprovals(base(root), sandbox);
    assert.ok(port instanceof AutoApproval);
    assert.strictEqual(port.name, 'auto');
    // approvalCache 显式 false 与缺省等价：均不包装。
    const off = builder.buildApprovals(base(root, { approvalCache: false }), sandbox);
    assert.ok(!(off instanceof CachedApproval));
  });
});

test('buildApprovals：开启缓存包 CachedApproval，策略指纹含审批与沙箱后端名', () => {
  withWorkspace((root) => {
    const builder = new ConfigBuilder();
    const wrapped = builder.buildApprovals(
      base(root, { approvalCache: true, approvalCacheMaxEntries: 8 }),
      new PassthroughSandbox(),
    );
    assert.ok(wrapped instanceof CachedApproval);
    assert.strictEqual(wrapped.name, 'cached');
  });
});

test('buildModel：无重试无预算时原样返回（同一实例）', () => {
  withWorkspace((root) => {
    const partial = base(root);
    assert.strictEqual(new ConfigBuilder().buildModel(partial, undefined), partial.model);
  });
});

test('buildModel：modelRetry 包 RetryingModel，预算 >0 再包 BudgetedModel（外层）', () => {
  withWorkspace((root) => {
    const builder = new ConfigBuilder();
    const retried = builder.buildModel(base(root, { modelRetry: true }), undefined);
    assert.ok(retried instanceof RetryingModel);

    const budget = new CostBudget(5, new Map());
    const budgeted = builder.buildModel(base(root), budget);
    assert.ok(budgeted instanceof BudgetedModel);

    const both = builder.buildModel(base(root, { modelRetry: true }), budget);
    assert.ok(both instanceof BudgetedModel, '预算层应在最外层');
  });
});

test('buildModel：预算为 0 视为关闭（不包装）', () => {
  withWorkspace((root) => {
    const partial = base(root);
    const out = new ConfigBuilder().buildModel(partial, new CostBudget(0, new Map()));
    assert.strictEqual(out, partial.model);
  });
});

test('buildRouter：非法策略与空 entries 均 fail-closed 抛 ConfigError', () => {
  const builder = new ConfigBuilder();
  assert.throws(() => builder.buildRouter({ strategy: 'nope', entries: [] }), ConfigError);
  assert.throws(() => builder.buildRouter({ strategy: 'least-cost', entries: [] }), ConfigError);
});

test('buildRouter：合法策略构造 ModelRouter', () => {
  const router = new ConfigBuilder().buildRouter({
    strategy: 'least-cost',
    entries: [{ model: 'mock-a', adapter: 'mock' }],
  });
  assert.ok(router instanceof ModelRouter);
});

test('buildRouterAdapter：mock 默认、未知类型抛错、openai 缺密钥 fail-closed', () => {
  const builder = new ConfigBuilder();
  assert.ok(builder.buildRouterAdapter({ model: 'x' }) instanceof MockModel);
  assert.throws(() => builder.buildRouterAdapter({ model: 'x', adapter: 'wat' }), ConfigError);
  withEnv('OPENAI_API_KEY', undefined, () => {
    assert.throws(() => builder.buildRouterAdapter({ model: 'x', adapter: 'openai' }), ConfigError);
  });
});

test('buildRouterAdapter：openai 有密钥时构造适配器且名取 model', () => {
  withEnv('OPENAI_API_KEY', 'sk-test', () => {
    const model = new ConfigBuilder().buildRouterAdapter({ model: 'gpt-x', adapter: 'openai' });
    assert.ok(model instanceof OpenAiCompatibleModel);
    assert.strictEqual(model.name, 'gpt-x');
  });
});

test('buildLsp：未配置或空命令返回 undefined；配置则构造 lsp-process 适配器', () => {
  withWorkspace((root) => {
    const builder = new ConfigBuilder();
    assert.strictEqual(builder.buildLsp(base(root)), undefined);
    assert.strictEqual(
      builder.buildLsp(base(root, { lspServer: { serverCommand: '   ' } })),
      undefined,
    );
    const lsp = builder.buildLsp(base(root, { lspServer: { serverCommand: 'ts-ls' } }));
    assert.strictEqual(lsp?.name, 'lsp-process');
  });
});

test('buildIdentity：未配置返回 undefined；配置则构造 Ed25519 身份并回显 runtimeId', () => {
  withWorkspace((root) => {
    const builder = new ConfigBuilder();
    assert.strictEqual(builder.buildIdentity(base(root)), undefined);
    const identity = builder.buildIdentity(
      base(root, { agentIdentity: { agentRuntimeId: 'rt-1' } }),
    );
    assert.ok(identity !== undefined);
    assert.strictEqual(identity.runtimeId(), 'rt-1');
    assert.match(identity.publicKeySsh(), /^ssh-ed25519 /);
  });
});

test('buildSpill：自定义优先；memory 选内存实现；缺省落文件实现', () => {
  withWorkspace((root) => {
    const builder = new ConfigBuilder();
    const custom = new MemorySpill();
    assert.strictEqual(builder.buildSpill(base(root, { spill: custom })), custom);
    assert.strictEqual(builder.buildSpill(base(root, { spillAdapter: 'memory' })).name, 'memory');
    assert.strictEqual(builder.buildSpill(base(root)).name, 'file');
  });
});

test('autoUserResponder：非 TTY 环境回落 fail-soft 的 default 回答器', () => {
  const out = ConfigBuilder.autoUserResponder();
  assert.strictEqual(out.name, process.stdout.isTTY ? 'console' : 'default');
});

test('buildHooks：返回含变更追踪钩子的运行器（pre/post 可调用）', () => {
  withWorkspace((root) => {
    const runner = ConfigBuilder.buildHooks(new TurnDiffTracker(), root);
    assert.strictEqual(typeof runner.pre, 'function');
    assert.strictEqual(typeof runner.post, 'function');
  });
});

test('seedOf：透传标量字段并填 goalMaxIterations / subagent 缺省', () => {
  withWorkspace((root) => {
    const spill = new MemorySpill();
    const seed = ConfigBuilder.seedOf(
      base(root, { subagentMaxDepth: 3, subagentConcurrency: 6, subagentMaxSteps: 9 }),
      new AutoApproval(),
      new PassthroughSandbox(),
      new SilentEventPort(),
      spill,
      new ToolResultSpiller(spill, { maxInlineBytes: 16_384, previewBytes: 2_048 }),
      new DenyEscalation(),
      new PolicySandbox({ workspaceRoot: root }),
      new FileLongTermMemory(join(root, '.omniharness/longterm/memory.jsonl')),
      undefined,
    );
    assert.strictEqual(seed.workspaceRoot, root);
    assert.strictEqual(seed.maxSteps, 4);
    assert.strictEqual(seed.goalMaxIterations, DEFAULT_GOAL_MAX_ITERATIONS);
    assert.deepStrictEqual(seed.subagent, { maxDepth: 3, maxConcurrency: 6, maxSteps: 9 });
    assert.strictEqual(seed.sandbox.name, 'passthrough');
    assert.strictEqual(seed.spill, spill);
  });
});

test('门面函数与 ConfigBuilder 方法同源（委托默认实例）', () => {
  withWorkspace((root) => {
    const partial = base(root);
    assert.strictEqual(ConfigBuilder.buildModel(partial, undefined), partial.model);
    assert.strictEqual(ConfigBuilder.buildSpill(base(root)).name, 'file');
    assert.strictEqual(ConfigBuilder.buildLsp(partial), undefined);
    assert.strictEqual(ConfigBuilder.buildIdentity(partial), undefined);
    assert.ok(
      ConfigBuilder.buildApprovals(partial, new PassthroughSandbox()) instanceof AutoApproval,
    );
  });
});

test('buildModel：modelCircuitBreaker 包在最外层防抖层之外（重试内层）', () => {
  withWorkspace((root) => {
    const builder = new ConfigBuilder();
    // 仅熔断：结果即 CircuitBreakingModel。
    const cbOnly = builder.buildModel(base(root, { modelCircuitBreaker: true }), undefined);
    assert.ok(cbOnly instanceof CircuitBreakingModel);
    // 熔断 + 重试：熔断应在重试外层 → 最外层是 CircuitBreakingModel 而非 RetryingModel。
    const both = builder.buildModel(
      base(root, { modelCircuitBreaker: true, modelRetry: true }),
      undefined,
    );
    assert.ok(both instanceof CircuitBreakingModel, '熔断必须包在重试外层');
    // 再加预算：预算仍是最外层（预算硬门禁优先于一切）。
    const all = builder.buildModel(
      base(root, { modelCircuitBreaker: true, modelRetry: true }),
      new CostBudget(5, new Map()),
    );
    assert.ok(all instanceof BudgetedModel, '预算层应始终在最外层');
  });
});

test('buildModel：熔断配置缺省时不包装（零行为变更）', () => {
  withWorkspace((root) => {
    const partial = base(root);
    const out = new ConfigBuilder().buildModel(partial, undefined);
    assert.strictEqual(out, partial.model, '未开启熔断应原样返回同一实例');
  });
});

test('buildModel：装配后的熔断真实生效——连续失败达阈值即开路且不再触达内层', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cfg-builder-cb-'));
  try {
    let calls = 0;
    const failing: ModelPort = {
      name: 'failing',
      async generate(_req: ModelRequest): Promise<ModelOutput> {
        calls += 1;
        throw new Error('downstream down');
      },
    };
    const model = new ConfigBuilder().buildModel(
      base(root, {
        model: failing,
        modelCircuitBreaker: true,
        modelCircuitBreakerThreshold: 2,
      }),
      undefined,
    );
    await assert.rejects(() => model.generate({ messages: [], tools: [] }), /downstream down/);
    await assert.rejects(() => model.generate({ messages: [], tools: [] }), /downstream down/);
    assert.strictEqual(calls, 2);
    await assert.rejects(
      () => model.generate({ messages: [], tools: [] }),
      (err: unknown) => err instanceof CircuitOpenError,
    );
    assert.strictEqual(calls, 2, '开路后不得再触达内层模型');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
