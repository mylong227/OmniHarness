// 取消传播探针（线索 3）：父会话 cancelCurrentRun → 子代理 / 工作流 / 目标循环
// 必须在飞模型请求上观察到中止；否则等于「父已取消，子代仍在烧 token」。
//
// 造法：
//  - 工作流 / 目标循环：真实 Agent 主循环 + 真实工具注册表（这两条路径不建隔离工作树）；
//  - 子代理：直接驱动 SubagentRunner（隔离工作树的创建在编排器层，本机沙箱禁写 tmpdir，
//    故编排器层只覆盖「已取消即不派生」的 fail-closed 前置判定）。
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { EventPort } from '../../src/ports/runtime/eventPort.js';
import type { ModelOutput, ModelPort, ModelRequest } from '../../src/ports/model/model.js';
import type { ToolPort } from '../../src/ports/tool/tool.js';
import type { ToolContext } from '../../src/ports/tool/tool.js';
import type { LongTermMemoryPort, MemoryFact } from '../../src/ports/memory/longTermMemory.js';
import { AutoApproval } from '../../src/adapters/approval/autoApproval.js';
import { MemoryStorage } from '../../src/adapters/storage/memoryStorage.js';
import { SilentEventPort } from '../../src/adapters/event/silentEventPort.js';
import { PassthroughSandbox } from '../../src/adapters/sandbox/passthroughSandbox.js';
import { DenyEscalation } from '../../src/adapters/escalation/denyEscalation.js';
import { MemorySpill } from '../../src/adapters/spill/memorySpill.js';
import { RegistryToolPort } from '../../src/adapters/tool/registryToolPort.js';
import { SubagentTool } from '../../src/adapters/tool/workflow/subagentTool.js';
import { ToolResultSpiller } from '../../src/context/toolResultSpiller.js';
import { ConfigFactory } from '../../src/config/configFactory.js';
import { createRuntime } from '../../src/composition/runtime.js';
import { Agent } from '../../src/core/agent.js';
import { SubagentOrchestrator } from '../../src/subagent/subagentOrchestrator.js';
import { SubagentRunner } from '../../src/subagent/subagentRunner.js';
import type { SubagentPorts } from '../../src/subagent/subagentPorts.js';
import type { SubagentRequest } from '../../src/subagent/subagentTypes.js';

// 关掉 repo-map 注入：本文件只审计取消传播控制流，索引整个仓库既慢又与断言无关。
process.env.OMNI_REPO_MAP = '0';

/** 子代观测：其上飞模型请求携带的信号是否被中止。 */
interface ChildObservation {
  /** 子代模型请求携带的取消信号（父取消应使其 abort）。 */
  readonly signal: AbortSignal | undefined;
  /** 该信号是否已中止。 */
  aborted: boolean;
}

/** 睡眠。 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 轮询等待条件成立；超时返回 false（不抛，便于断言给出可读证据）。 */
async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return true;
    }
    await sleep(20);
  }
  return predicate();
}

/**
 * 双角色脚本模型：父角色首轮派生一次子任务；命中「子代标记」的请求挂起，
 * 直到取消信号 abort 或测试显式放行。
 */
class TreeModel implements ModelPort {
  /** 端口名（模型适配器标识）。 */
  public readonly name = 'tree';
  /** 子代观测记录（每进入一次子代模型调用追加一条）。 */
  public readonly children: ChildObservation[] = [];
  /** 全部子代（非父会话）请求的 prompt（用于断言「某一步根本没启动」）。 */
  public readonly prompts: string[] = [];
  /** 父会话为派生发起的模型调用次数。 */
  public parentCalls = 0;

  /** 放行当前挂起子代请求的 resolve（无挂起时为 undefined）。 */
  private release: (() => void) | undefined;

  public constructor(
    private readonly spawn: ModelOutput,
    private readonly childMarker: string,
  ) {}

  /**
   * 是否已有子代进入模型调用。
   * @returns 已有子代观测记录时为 true
   */
  public childStarted(): boolean {
    return this.children.length > 0;
  }

  /**
   * 是否有子代观测到信号中止。
   * @returns 任一子代观测到 abort 时为 true
   */
  public anyChildAborted(): boolean {
    return this.children.some((child) => child.aborted);
  }

  /**
   * 是否见到过某个 prompt（用于断言取消后不再启动后续步骤）。
   * @param marker 要匹配的 prompt 片段
   * @returns 已有子代请求的 prompt 含该片段时为 true
   */
  public sawPrompt(marker: string): boolean {
    return this.prompts.some((prompt) => prompt.includes(marker));
  }

  /**
   * 放行所有挂起的子代请求（避免测试结束时留下未 settle 的 promise）。
   * @returns 无
   */
  public releaseAll(): void {
    this.release?.();
  }

  /**
   * 按角色分派：父会话首轮派生一次子任务，子代目标 prompt 则挂起等待取消/放行。
   * @param request 模型请求（含工具清单、消息与取消信号）
   * @returns 本步的模型输出
   */
  public async generate(request: ModelRequest): Promise<ModelOutput> {
    if (request.tools.some((tool) => tool.name === 'subagent')) {
      this.parentCalls += 1;
      return this.parentCalls === 1 ? this.spawn : { text: '父会话完成' };
    }
    const prompt = [...request.messages]
      .reverse()
      .find((message) => message.role === 'user')?.content;
    if (prompt === undefined) {
      return { text: '非目标子步' };
    }
    this.prompts.push(prompt);
    if (!prompt.includes(this.childMarker)) {
      return { text: '非目标子步' };
    }
    const observation: ChildObservation = { signal: request.signal, aborted: false };
    this.children.push(observation);
    // 只挂起**首次**子代调用：目标循环的后续迭代 prompt 同样含标记，重复挂起会让断言无从收敛。
    if (this.children.length > 1) {
      return { text: '后续子步完成' };
    }
    await this.blockUntilAbort(observation);
    return { text: '子代完成' };
  }

  /**
   * 挂起直到信号中止（记录观测）或测试放行。
   * @param observation 本次子代调用的观测记录
   * @returns 挂起结束后的 Promise
   */
  private async blockUntilAbort(observation: ChildObservation): Promise<void> {
    const signal = observation.signal;
    await new Promise<void>((resolve) => {
      this.release = resolve;
      if (signal === undefined) {
        return;
      }
      if (signal.aborted) {
        observation.aborted = true;
        resolve();
        return;
      }
      signal.addEventListener(
        'abort',
        () => {
          observation.aborted = true;
          resolve();
        },
        { once: true },
      );
    });
  }
}

/** 内存版长期记忆桩。 */
function makeLongTermStub(): LongTermMemoryPort {
  const facts: MemoryFact[] = [];
  return {
    name: 'stub',
    remember: (fact) => facts.push(fact),
    recall: (query, k) =>
      facts
        .map((fact, index) => ({ fact, score: fact.text.includes(query) ? 1 : 0, index }))
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, k)
        .map((entry) => entry.fact),
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

/** 收集型事件端口。 */
class RecordingEvents implements EventPort {
  /** 端口名（事件适配器标识）。 */
  public readonly name = 'recording';
  /** 已收到的事件（按到达顺序）。 */
  public readonly received: unknown[] = [];
  /**
   * 记录一个事件。
   * @param event 待记录的事件
   * @returns 无
   */
  public emit(event: never): void {
    this.received.push(event);
  }
}

/** 构造子智能体端口集（工作区用仓库根：沙箱禁写 tmpdir，子代理测试不建隔离工作树）。 */
function makePorts(model: ModelPort, tools: ToolPort): SubagentPorts {
  const spill = new MemorySpill();
  return {
    model,
    tools,
    storage: new MemoryStorage(),
    events: new RecordingEvents(),
    sandbox: new PassthroughSandbox(),
    approvals: new AutoApproval(),
    escalation: new DenyEscalation(),
    elevatedSandbox: new PassthroughSandbox(),
    spill,
    spiller: new ToolResultSpiller(spill, { maxInlineBytes: 1024, previewBytes: 256 }),
    workspaceRoot: process.cwd(),
    maxSteps: 8,
    longTermMemory: makeLongTermStub(),
    goalMaxIterations: 10,
  };
}

/** 造一个可跑真实工具注册表的父 Agent。 */
function buildAgent(model: ModelPort): Agent {
  const config = ConfigFactory.build({
    workspaceRoot: process.cwd(),
    maxSteps: 6,
    model,
    storage: new MemoryStorage(),
    events: new SilentEventPort(),
    spillAdapter: 'memory',
  });
  return new Agent(createRuntime(config));
}

/**
 * 「被中止即抛错」的子代模型（模拟真实 fetch：signal abort → 请求 reject）。
 * 用于断言取消后子代**立即收尾**且不再发起新请求。
 */
class AbortingChildModel implements ModelPort {
  /** 端口名（模型适配器标识）。 */
  public readonly name = 'aborting-child';
  /** 子代模型调用次数（取消后必须停在 1）。 */
  public childCalls = 0;

  public constructor(private readonly marker: string) {}

  /**
   * 命中标记的子代调用挂起，直到取消信号 abort 时以失败 reject。
   * @param request 模型请求（含消息与取消信号）
   * @returns 未被取消时的模型输出（取消则 reject，不返回）
   */
  public async generate(request: ModelRequest): Promise<ModelOutput> {
    const prompt = [...request.messages]
      .reverse()
      .find((message) => message.role === 'user')?.content;
    if (prompt === undefined || !prompt.includes(this.marker)) {
      return { text: '非目标子步' };
    }
    this.childCalls += 1;
    const signal = request.signal;
    await new Promise<void>((_resolve, reject) => {
      if (signal === undefined) {
        return;
      }
      if (signal.aborted) {
        reject(new Error('请求已中止（模拟 fetch abort）'));
        return;
      }
      signal.addEventListener('abort', () => reject(new Error('请求已中止（模拟 fetch abort）')), {
        once: true,
      });
    });
    return { text: '子代完成' };
  }
}

describe('取消传播（父 cancelCurrentRun → 子代）', () => {
  it('父取消后工作流步骤的在飞模型请求被中止', async () => {
    const model = new TreeModel(
      {
        toolCalls: [
          {
            id: 'c1',
            name: 'run_workflow',
            arguments: { spec: { steps: [{ id: 'A', prompt: '工作流标记-挂起' }] } },
          },
        ],
      },
      '工作流标记-挂起',
    );
    const agent = buildAgent(model);
    const run = agent.runTask('跑一个工作流');
    assert.ok(await waitFor(() => model.childStarted(), 8000), '工作流步骤应已进入模型调用');

    agent.cancelCurrentRun('user');
    const aborted = await waitFor(() => model.anyChildAborted(), 1000);
    model.releaseAll();
    await run.catch(() => undefined);
    assert.ok(aborted, '父取消后工作流步骤未收到 abort ⇒ 取消未传播到工作流（步骤仍在跑）');
  });

  it('父取消后目标循环的在飞模型请求被中止', async () => {
    const model = new TreeModel(
      { toolCalls: [{ id: 'c1', name: 'run_goal', arguments: { goal: '目标标记-挂起' } }] },
      '目标标记-挂起',
    );
    const agent = buildAgent(model);
    const run = agent.runTask('跑一个目标循环');
    assert.ok(await waitFor(() => model.childStarted(), 8000), '目标循环应已进入模型调用');

    agent.cancelCurrentRun('user');
    const aborted = await waitFor(() => model.anyChildAborted(), 1000);
    model.releaseAll();
    await run.catch(() => undefined);
    assert.ok(aborted, '父取消后目标循环未收到 abort ⇒ 取消未传播到目标循环（仍在跑）');
  });

  it('父取消后子代理的在飞模型请求被中止（SubagentRunner 层）', async () => {
    const model = new TreeModel({ text: 'unused' }, '子任务标记-挂起');
    const runner = new SubagentRunner(makePorts(model, new RegistryToolPort()), 8);
    const controller = new AbortController();
    const request: SubagentRequest = {
      task: '子任务标记-挂起',
      parentSessionId: 'parent',
      depth: 1,
      signal: controller.signal,
    };
    const run = runner.run(request);
    assert.ok(await waitFor(() => model.childStarted(), 8000), '子代理应已进入模型调用');

    controller.abort('user');
    const aborted = await waitFor(() => model.anyChildAborted(), 1000);
    model.releaseAll();
    await run.catch(() => undefined);
    assert.ok(aborted, '父取消后子代理未收到 abort ⇒ 取消未传播到子代理（子代仍在跑）');
  });

  it('父取消后子代在飞请求失败即收尾，不再发起新请求', async () => {
    const model = new AbortingChildModel('子任务标记-挂起');
    const runner = new SubagentRunner(makePorts(model, new RegistryToolPort()), 8);
    const controller = new AbortController();
    const run = runner.run({
      task: '子任务标记-挂起',
      parentSessionId: 'parent',
      depth: 1,
      signal: controller.signal,
    });
    assert.ok(await waitFor(() => model.childCalls === 1, 8000), '子代理应已发起模型请求');

    controller.abort('user');
    const settled = await run.then(
      () => 'resolved',
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    assert.strictEqual(typeof settled, 'string', '取消后子代应以失败收尾（异常上抛/失败结果）');
    assert.notStrictEqual(settled, 'resolved', '取消后子代不应「正常完成」');
    assert.strictEqual(model.childCalls, 1, '取消后不得再发起新的模型请求（不继续烧 token）');
  });

  it('父取消后工作流不再启动下一层步骤', async () => {
    const model = new TreeModel(
      {
        toolCalls: [
          {
            id: 'c1',
            name: 'run_workflow',
            arguments: {
              spec: {
                steps: [
                  { id: 'A', prompt: '工作流标记-挂起' },
                  { id: 'B', prompt: '第二层标记-不应启动', dependsOn: ['A'] },
                ],
              },
            },
          },
        ],
      },
      '工作流标记-挂起',
    );
    const agent = buildAgent(model);
    const run = agent.runTask('跑一个两层工作流');
    assert.ok(await waitFor(() => model.childStarted(), 8000), '工作流首层应已进入模型调用');

    agent.cancelCurrentRun('user');
    await waitFor(() => model.anyChildAborted(), 1000);
    model.releaseAll();
    await run.catch(() => undefined);
    assert.ok(
      !model.sawPrompt('第二层标记-不应启动'),
      '父取消后工作流仍启动了下一层步骤 ⇒ 取消未阻断后续调度',
    );
  });

  it('已取消时不派生子代理（fail-closed，不建隔离工作树）', async () => {
    const model = new TreeModel({ text: 'unused' }, '子任务标记-挂起');
    const orchestrator = new SubagentOrchestrator(makePorts(model, new RegistryToolPort()));
    const controller = new AbortController();
    controller.abort('user');
    const tool = new SubagentTool(orchestrator);
    const context: ToolContext = {
      sessionId: 'parent',
      workspaceRoot: process.cwd(),
      signal: controller.signal,
    };
    const result = await tool.handle(
      { id: 'c1', name: 'subagent', arguments: { task: '子任务标记-挂起' } },
      context,
    );
    assert.strictEqual(result.ok, false, '父已取消时派生应 fail-closed 拒绝');
    assert.match(result.error ?? '', /取消/, '拒绝原因应说明是取消，而不是隔离工作树创建失败');
    assert.strictEqual(model.parentCalls, 0, '已取消时不得进入子代模型调用');
  });
});
