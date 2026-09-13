import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EventPort } from '../../src/ports/runtime/eventPort.js';
import type { ModelOutput, ModelPort, ModelRequest } from '../../src/ports/model/model.js';
import type { SessionEvent } from '../../src/ports/runtime/event.js';
import type { ToolPort } from '../../src/ports/tool/tool.js';
import type { LongTermMemoryPort, MemoryFact } from '../../src/ports/memory/longTermMemory.js';
import { AutoApproval } from '../../src/adapters/approval/autoApproval.js';
import { MemoryStorage } from '../../src/adapters/storage/memoryStorage.js';
import { PassthroughSandbox } from '../../src/adapters/sandbox/passthroughSandbox.js';
import { DenyEscalation } from '../../src/adapters/escalation/denyEscalation.js';
import { MemorySpill } from '../../src/adapters/spill/memorySpill.js';
import { RegistryToolPort } from '../../src/adapters/tool/registryToolPort.js';
import { SubagentTool } from '../../src/adapters/tool/workflow/subagentTool.js';
import { ToolResultSpiller } from '../../src/context/toolResultSpiller.js';
import { ConcurrencyLimiter } from '../../src/util/concurrencyLimiter.js';
import { ConfigFactory } from '../../src/config/configFactory.js';
import { createRuntime } from '../../src/core/runtime.js';
import { Agent } from '../../src/core/agent.js';
import { SubagentOrchestrator } from '../../src/subagent/subagentOrchestrator.js';
import { SubagentRunner } from '../../src/subagent/subagentRunner.js';
import { ToolSubset } from '../../src/subagent/toolSubset.js';
import type { SubagentPorts } from '../../src/subagent/subagentPorts.js';

/** 可观测模型：记录每轮可见工具名、并发峰值，可注入延迟与故障。 */
class ObservableModel implements ModelPort {
  public readonly name = 'observable';

  private active = 0;
  private peak = 0;
  public readonly frames: string[][] = [];

  public constructor(
    private readonly delayMs = 0,
    private readonly fail = false,
  ) {}

  /** 观测到的并发峰值。 */
  public peakOf(): number {
    return this.peak;
  }

  public async generate(request: ModelRequest): Promise<ModelOutput> {
    this.active += 1;
    this.peak = Math.max(this.peak, this.active);
    this.frames.push(request.tools.map((tool) => tool.name));
    try {
      if (this.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.delayMs));
      }
      if (this.fail) {
        throw new Error('模型不可用（测试注入）');
      }
      return { text: '子任务完成' };
    } finally {
      this.active -= 1;
    }
  }
}

/**
 * 会派生一次子智能体的脚本化模型。
 * 判别主/子代的方式：子代工具集已剔除 subagent，故 tools 里没有它即为子代视角。
 */
class SpawnOnceModel implements ModelPort {
  public readonly name = 'spawn-once';

  private parentCalls = 0;

  public async generate(request: ModelRequest): Promise<ModelOutput> {
    if (!request.tools.some((tool) => tool.name === 'subagent')) {
      return { text: '子智能体产出的结论' };
    }
    this.parentCalls += 1;
    if (this.parentCalls === 1) {
      return {
        toolCalls: [{ id: 'call_1', name: 'subagent', arguments: { task: '调研一下' } }],
      };
    }
    return { text: '主会话已汇总子智能体结论' };
  }
}

/** 收集型事件端口（验证子会话事件是否外溢到父流）。 */
class RecordingEvents implements EventPort {
  public readonly name = 'recording';
  public readonly received: SessionEvent[] = [];

  public emit(event: SessionEvent): void {
    this.received.push(event);
  }
}

/** 睡眠。 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 测试用隔离工作根：落在 os.tmpdir()（本机非 git 仓库），
 * 使子智能体隔离逻辑(createWorktree)走「git 不可用 → 目录拷贝降级」快速路径，
 * 避免对巨型仓库执行真实 `git worktree add` checkout（本机约 24s/次）拖垮单测。
 */
let testRoot: string | undefined;
function getTestRoot(): string {
  if (testRoot === undefined) {
    testRoot = mkdtempSync(join(tmpdir(), 'omni-subagent-'));
  }
  return testRoot;
}
after(() => {
  if (testRoot !== undefined) {
    rmSync(testRoot, { recursive: true, force: true });
    testRoot = undefined;
  }
});

/** 构造含 echo/shell/subagent 三工具的注册表。 */
function makeTools(): RegistryToolPort {
  const registry = new RegistryToolPort();
  const blank = { type: 'object', properties: {}, required: [] } as const;
  registry.register({ name: 'echo', description: '回显', parameters: blank }, async (call) => ({
    callId: call.id,
    ok: true,
    output: 'echoed',
  }));
  registry.register({ name: 'shell', description: '命令', parameters: blank }, async (call) => ({
    callId: call.id,
    ok: true,
    output: 'runned',
  }));
  registry.register({ name: 'subagent', description: '派生', parameters: blank }, async (call) => ({
    callId: call.id,
    ok: true,
    output: 'spawned',
  }));
  return registry;
}

/** 内存版长期记忆桩（测试用，不落盘）。 */
function makeLongTermStub(): LongTermMemoryPort {
  const facts: MemoryFact[] = [];
  return {
    name: 'stub',
    remember: (fact) => facts.push(fact),
    recall: (query, k) =>
      facts
        .map((f, i) => ({ f, score: f.text.includes(query) ? 1 : 0, i }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, k)
        .map((x) => x.f),
    all: () => facts,
    get: (id) => facts.find((f) => f.id === id),
    update: (id, patch) => {
      const i = facts.findIndex((f) => f.id === id);
      if (i === -1) return false;
      facts[i] = { ...facts[i]!, ...patch };
      return true;
    },
    delete: (id) => {
      const i = facts.findIndex((f) => f.id === id);
      if (i === -1) return false;
      facts.splice(i, 1);
      return true;
    },
    get count() {
      return facts.length;
    },
  };
}

/** 构造子智能体端口集。 */
function makePorts(model: ModelPort, events: EventPort, tools: ToolPort): SubagentPorts {
  const spill = new MemorySpill();
  return {
    model,
    tools,
    storage: new MemoryStorage(),
    events,
    sandbox: new PassthroughSandbox(),
    approvals: new AutoApproval(),
    escalation: new DenyEscalation(),
    elevatedSandbox: new PassthroughSandbox(),
    spill,
    spiller: new ToolResultSpiller(spill, { maxInlineBytes: 1024, previewBytes: 256 }),
    workspaceRoot: getTestRoot(),
    maxSteps: 8,
    longTermMemory: makeLongTermStub(),
    goalMaxIterations: 10,
  };
}

describe('ConcurrencyLimiter', () => {
  it('并发峰值不超过上限', async () => {
    const limiter = new ConcurrencyLimiter(2);
    let active = 0;
    let peak = 0;
    await Promise.all(
      [1, 2, 3, 4, 5, 6].map(() =>
        limiter.run(async () => {
          active += 1;
          peak = Math.max(peak, active);
          await sleep(5);
          active -= 1;
        }),
      ),
    );
    assert.strictEqual(peak, 2);
    assert.strictEqual(limiter.activeCount(), 0, '全部完成后活跃数应归零');
  });

  it('异常也保证释放槽位', async () => {
    const limiter = new ConcurrencyLimiter(1);
    await assert.rejects(() =>
      limiter.run(async () => {
        throw new Error('boom');
      }),
    );
    assert.strictEqual(limiter.activeCount(), 0);
  });
});

describe('ToolSubset', () => {
  it('裁剪 list 并 fail-closed 拦截未授权执行', async () => {
    const subset = new ToolSubset(makeTools(), new Set(['echo']));
    assert.deepStrictEqual(
      subset.list().map((tool) => tool.name),
      ['echo'],
    );

    const allowed = await subset.execute(
      { id: 'c1', name: 'echo', arguments: {} },
      { sessionId: 's', workspaceRoot: getTestRoot() },
    );
    assert.strictEqual(allowed.ok, true);

    const denied = await subset.execute(
      { id: 'c2', name: 'shell', arguments: {} },
      { sessionId: 's', workspaceRoot: getTestRoot() },
    );
    assert.strictEqual(denied.ok, false);
    assert.match(denied.error ?? '', /未被授权/);
  });
});

describe('SubagentRunner', () => {
  it('子代工具集剔除 subagent 自身（杜绝进程内递归）', async () => {
    const model = new ObservableModel();
    const runner = new SubagentRunner(makePorts(model, new RecordingEvents(), makeTools()), 8);
    const result = await runner.run({ task: '做点事', parentSessionId: 'parent', depth: 1 });

    assert.strictEqual(result.ok, true);
    assert.notStrictEqual(result.sessionId, 'parent', '子代应有独立 sessionId');
    const visible = model.frames[0] ?? [];
    assert.ok(!visible.includes('subagent'), `子代不应看到 subagent，实际: ${visible.join(',')}`);
    assert.ok(visible.includes('echo'));
    assert.ok(visible.includes('shell'));
  });

  it('指定白名单时子代只看到授权工具', async () => {
    const model = new ObservableModel();
    const runner = new SubagentRunner(makePorts(model, new RecordingEvents(), makeTools()), 8);
    await runner.run({ task: '只读任务', parentSessionId: 'parent', depth: 1, tools: ['echo'] });

    assert.deepStrictEqual(model.frames[0], ['echo']);
  });

  it('子代步数上限独立于父配置', async () => {
    const model = new ObservableModel();
    const runner = new SubagentRunner(makePorts(model, new RecordingEvents(), makeTools()), 1);
    const result = await runner.run({ task: '受限任务', parentSessionId: 'parent', depth: 1 });
    assert.strictEqual(result.steps, 1);
  });
});

describe('SubagentOrchestrator', () => {
  it('成功执行并记录父子关系', async () => {
    const events = new RecordingEvents();
    const orchestrator = new SubagentOrchestrator(
      makePorts(new ObservableModel(), events, makeTools()),
    );
    const result = await orchestrator.run({
      task: '子任务',
      parentSessionId: 'parent-1',
      depth: 1,
    });

    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(orchestrator.childrenOf('parent-1'), [result.sessionId]);
    assert.deepStrictEqual(orchestrator.childrenOf('unknown'), []);
  });

  it('深度超限被拒且不执行', async () => {
    const model = new ObservableModel();
    const orchestrator = new SubagentOrchestrator(
      makePorts(model, new RecordingEvents(), makeTools()),
      { maxDepth: 2 },
    );
    const result = await orchestrator.run({
      task: '过深任务',
      parentSessionId: 'parent',
      depth: 2,
    });

    assert.strictEqual(result.ok, false);
    assert.match(result.error ?? '', /深度/);
    assert.strictEqual(model.frames.length, 0, '被拒时不应调用模型');
    assert.deepStrictEqual(orchestrator.childrenOf('parent'), []);
  });

  it('子会话事件不污染父观测流，但随结果可取回', async () => {
    const events = new RecordingEvents();
    const orchestrator = new SubagentOrchestrator(
      makePorts(new ObservableModel(), events, makeTools()),
    );
    const result = await orchestrator.run({
      task: '安静任务',
      parentSessionId: 'parent',
      depth: 1,
    });

    assert.strictEqual(events.received.length, 0, '子会话事件不应广播到父事件端口');
    assert.ok(result.events.length > 0, '子会话完整轨迹应随结果返回');
  });

  it('并发上限不被突破（批量任务）', async () => {
    const model = new ObservableModel(10);
    const orchestrator = new SubagentOrchestrator(
      makePorts(model, new RecordingEvents(), makeTools()),
      { maxConcurrency: 2 },
    );
    const results = await orchestrator.runAll(
      [1, 2, 3, 4, 5].map((index) => ({
        task: `任务${index}`,
        parentSessionId: 'parent',
        depth: 1,
      })),
    );

    assert.strictEqual(results.length, 5);
    assert.ok(results.every((entry) => entry.ok));
    assert.ok(model.peakOf() <= 2, `并发峰值应 <=2，实际 ${model.peakOf()}`);
    assert.strictEqual(orchestrator.childrenOf('parent').length, 5);
  });

  it('模型异常转为失败结果而非抛出', async () => {
    const orchestrator = new SubagentOrchestrator(
      makePorts(new ObservableModel(0, true), new RecordingEvents(), makeTools()),
    );
    const result = await orchestrator.run({ task: '会失败的任务', parentSessionId: 'p', depth: 1 });

    assert.strictEqual(result.ok, false);
    assert.match(result.error ?? '', /模型不可用/);
  });
});

describe('子智能体端到端（真实主循环）', () => {
  it('主会话调用 subagent 工具并取回子代结论', async () => {
    const events = new RecordingEvents();
    const config = ConfigFactory.build({
      workspaceRoot: getTestRoot(),
      maxSteps: 6,
      model: new SpawnOnceModel(),
      storage: new MemoryStorage(),
      events,
      spillAdapter: 'memory',
    });
    const runtime = createRuntime(config);
    const result = await new Agent(runtime).runTask('派一个子智能体去做调研');

    assert.ok(result.finalText !== undefined);
    const toolResults = result.events.filter((event) => event.type === 'tool_result');
    const spawned = toolResults.find((event) =>
      JSON.stringify(event.payload).includes('子智能体 sess'),
    );
    assert.ok(spawned !== undefined, '事件流中应出现子智能体的工具结果');
    assert.match(JSON.stringify(spawned?.payload), /子智能体产出的结论/);
  });
});

describe('SubagentTool', () => {
  it('缺少 task 直接拒绝', async () => {
    const tool = new SubagentTool(
      new SubagentOrchestrator(
        makePorts(new ObservableModel(), new RecordingEvents(), makeTools()),
      ),
    );
    const result = await tool.handle(
      { id: 'c1', name: 'subagent', arguments: {} },
      { sessionId: 's', workspaceRoot: getTestRoot() },
    );
    assert.strictEqual(result.ok, false);
    assert.match(result.error ?? '', /缺少子任务描述/);
  });

  it('成功时输出含子会话元信息', async () => {
    const tool = new SubagentTool(
      new SubagentOrchestrator(
        makePorts(new ObservableModel(), new RecordingEvents(), makeTools()),
      ),
    );
    const result = await tool.handle(
      { id: 'c2', name: 'subagent', arguments: { task: '写个总结' } },
      { sessionId: 's', workspaceRoot: getTestRoot() },
    );
    assert.strictEqual(result.ok, true);
    assert.match(result.output ?? '', /\[子智能体 .+\] \d+ 步 \/ \d+ms/);
    assert.match(result.output ?? '', /子任务完成/);
  });

  it('tools 白名单经注册表 array 校验后生效', async () => {
    const model = new ObservableModel();
    const tool = new SubagentTool(
      new SubagentOrchestrator(makePorts(model, new RecordingEvents(), makeTools())),
    );
    const result = await tool.handle(
      { id: 'c3', name: 'subagent', arguments: { task: '只读', tools: ['echo'] } },
      { sessionId: 's', workspaceRoot: getTestRoot() },
    );
    assert.strictEqual(result.ok, true, `应通过 array 类型校验，实际: ${result.error ?? ''}`);
    assert.deepStrictEqual(model.frames[0], ['echo']);
  });
});
