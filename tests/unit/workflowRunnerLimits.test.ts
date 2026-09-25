// 工作流入参校验 + 依赖传播语义 + 并发闸门 fail-closed 的探针与回归。
//
// 修复背景（2026-09-21 探针实测，修前红）：
//  1. `maxConcurrency: 0`（含负数/NaN/非数字）让并发闸门永不放行 ⇒ 工作流**永不 settle**
//     （不是报错、不是降级，是永久挂起）；`run_workflow` 是模型面入口，非法实参可直达。
//  2. 「成功但无 finalText」的步骤被并入失败集合 ⇒ 下游被 fail-closed 跳过、整体 ok=false
//     （把「这一步没吐文本」误判为「这一步失败了」，并传染全部下游）。
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { EventPort } from '../../src/ports/runtime/eventPort.js';
import type { ModelOutput, ModelPort, ModelRequest } from '../../src/ports/model/model.js';
import type { ToolPort } from '../../src/ports/tool/tool.js';
import type { LongTermMemoryPort, MemoryFact } from '../../src/ports/memory/longTermMemory.js';
import { AutoApproval } from '../../src/adapters/approval/autoApproval.js';
import { MemoryStorage } from '../../src/adapters/storage/memoryStorage.js';
import { PassthroughSandbox } from '../../src/adapters/sandbox/passthroughSandbox.js';
import { DenyEscalation } from '../../src/adapters/escalation/denyEscalation.js';
import { MemorySpill } from '../../src/adapters/spill/memorySpill.js';
import { RegistryToolPort } from '../../src/adapters/tool/registryToolPort.js';
import { RunWorkflowTool } from '../../src/adapters/tool/workflow/runWorkflowTool.js';
import { ToolResultSpiller } from '../../src/context/toolResultSpiller.js';
import { WorkflowRunner } from '../../src/autonomy/workflowRunner.js';
import { ConcurrencyLimiter } from '../../src/util/concurrencyLimiter.js';
import { SubagentOrchestrator } from '../../src/subagent/subagentOrchestrator.js';
import type { SubagentPortsShape } from '../../src/subagent/subagentPorts.js';

/** 探针观察结果：settle / reject / 超时（= 永久挂起）。 */
type Outcome<T> =
  | { readonly kind: 'value'; readonly value: T }
  | { readonly kind: 'error'; readonly error: unknown }
  | { readonly kind: 'timeout' };

/**
 * 竞速「待观察 promise」与「超时计时器」：超时即判定永久挂起（永不 settle）。
 * @param promise 待观察的 promise
 * @param ms 判定挂起的毫秒上限
 * @returns 三种结局的判别联合（value / error / timeout）
 */
async function outcomeOf<T>(promise: Promise<T>, ms: number): Promise<Outcome<T>> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<Outcome<T>>((resolve) => {
    timer = setTimeout(() => resolve({ kind: 'timeout' }), ms);
  });
  const settled = promise.then(
    (value): Outcome<T> => ({ kind: 'value', value }),
    (error): Outcome<T> => ({ kind: 'error', error }),
  );
  try {
    return await Promise.race([settled, timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/** 回显模型：返回最后一条 user 消息内容（验证依赖注入与步骤产出）。 */
class EchoModel implements ModelPort {
  /** 端口要求适配器名（这里用「回显」以自解释）。 */
  public readonly name = 'echo';

  /**
   * 回显最后一条 user 消息作为产出。
   *
   * @param request 模型请求
   * @returns 末条 user 消息内容；没有 user 消息时返回 done
   */
  public async generate(request: ModelRequest): Promise<ModelOutput> {
    const lastUser = [...request.messages].reverse().find((message) => message.role === 'user');
    return { text: lastUser !== undefined ? lastUser.content : 'done' };
  }
}

/** 空产出模型：会话内出现「空产出」标记时返回无文本（成功但 finalText 为 undefined）。 */
class EmptyOutputModel implements ModelPort {
  /** 端口要求适配器名（标明它故意返回空产出）。 */
  public readonly name = 'empty-output';

  /**
   * 出现「空产出」标记时返回空文本（模拟"成功但无 finalText"）。
   *
   * @param request 模型请求
   * @returns 含标记时 `text: undefined`，否则回显末条 user 消息
   */
  public async generate(request: ModelRequest): Promise<ModelOutput> {
    const marked = request.messages.some(
      (message) => message.role === 'user' && message.content.includes('空产出'),
    );
    if (marked) {
      return { text: undefined };
    }
    const lastUser = [...request.messages].reverse().find((message) => message.role === 'user');
    return { text: lastUser?.content ?? 'done' };
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
  /** 端口要求适配器名（标明它只做记录）。 */
  public readonly name = 'recording';
  /** 已收到的事件（按序，供断言事件确实被发出）。 */
  public readonly received: unknown[] = [];

  /**
   * 记录一条事件。
   *
   * @param event 事件对象
   * @returns 无返回值
   */
  public emit(event: never): void {
    this.received.push(event);
  }
}

/** 构造子智能体端口集。 */
function makePorts(model: ModelPort, events: EventPort, tools: ToolPort): SubagentPortsShape {
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
    workspaceRoot: process.cwd(),
    maxSteps: 8,
    longTermMemory: makeLongTermStub(),
    goalMaxIterations: 10,
  };
}

/** 造一个可用 runner（默认模型为回显）。 */
function makeRunner(model: ModelPort = new EchoModel()): WorkflowRunner {
  return new WorkflowRunner(makePorts(model, new RecordingEvents(), new RegistryToolPort()));
}

/** 非法并发上限样本（0/负数/NaN/非数字均曾导致闸门永不放行）。 */
const BAD_CONCURRENCY: readonly unknown[] = [0, -1, Number.NaN, '2'];

describe('WorkflowRunner 入参校验（maxConcurrency fail-closed）', () => {
  it('maxConcurrency=0 不得永久挂起', async () => {
    const outcome = await outcomeOf(
      makeRunner().run({ steps: [{ id: 'A', prompt: 'a' }], maxConcurrency: 0 }),
      1000,
    );
    assert.notStrictEqual(outcome.kind, 'timeout', '工作流在 1000ms 内未 settle ⇒ 永久挂起');
    assert.strictEqual(outcome.kind, 'error', 'maxConcurrency=0 应 fail-closed 拒绝，而非静默降级');
  });

  it('maxConcurrency 为负数 / NaN / 非数字均 fail-closed', async () => {
    for (const value of BAD_CONCURRENCY) {
      const outcome = await outcomeOf(
        makeRunner().run({
          steps: [{ id: 'A', prompt: 'a' }],
          maxConcurrency: value as number,
        }),
        1000,
      );
      assert.notStrictEqual(
        outcome.kind,
        'timeout',
        `maxConcurrency=${String(value)} 挂起（永不 settle）`,
      );
      assert.strictEqual(outcome.kind, 'error', `maxConcurrency=${String(value)} 应被拒绝`);
    }
  });

  it('构造期 maxConcurrency=0 直接拒绝（不留给 run 挂死）', () => {
    assert.throws(
      () =>
        new WorkflowRunner(
          makePorts(new EchoModel(), new RecordingEvents(), new RegistryToolPort()),
          { maxConcurrency: 0 },
        ),
      /maxConcurrency/,
    );
  });

  it('合法 maxConcurrency 正常执行（1 / 2 / 缺省）', async () => {
    for (const value of [1, 2, undefined]) {
      const runner = makeRunner();
      const result = await runner.run({
        steps: [
          { id: 'A', prompt: 'a' },
          { id: 'B', prompt: 'b', dependsOn: ['A'] },
        ],
        ...(value === undefined ? {} : { maxConcurrency: value }),
      });
      assert.strictEqual(result.ok, true, `maxConcurrency=${String(value)} 应正常完成`);
    }
  });
});

describe('RunWorkflowTool 入参校验（模型面入口）', () => {
  it('spec.maxConcurrency 非法即拒绝，且不挂起', async () => {
    for (const bad of BAD_CONCURRENCY) {
      const tool = new RunWorkflowTool(
        makePorts(new EchoModel(), new RecordingEvents(), new RegistryToolPort()),
      );
      const outcome = await outcomeOf(
        tool.handle(
          {
            id: 'c1',
            name: 'run_workflow',
            arguments: {
              spec: { steps: [{ id: 'A', prompt: 'a' }], maxConcurrency: bad },
            },
          },
          { sessionId: 's', workspaceRoot: process.cwd() },
        ),
        1000,
      );
      assert.notStrictEqual(
        outcome.kind,
        'timeout',
        `spec.maxConcurrency=${String(bad)} 让工具调用永久挂起`,
      );
      assert.strictEqual(outcome.kind, 'value', '工具应返回失败结果，而不是抛异常');
      if (outcome.kind !== 'value') {
        return;
      }
      assert.strictEqual(outcome.value.ok, false, `spec.maxConcurrency=${String(bad)} 应被拒绝`);
      assert.match(
        outcome.value.error ?? '',
        /maxConcurrency/,
        '拒绝原因应点名非法字段（可执行错误）',
      );
    }
  });
});

describe('WorkflowRunner 依赖传播语义（成功但无产出）', () => {
  it('成功但无产出（finalText=undefined）不应把下游判为依赖失败', async () => {
    const runner = makeRunner(new EmptyOutputModel());
    const result = await runner.run({
      steps: [
        { id: 'A', prompt: '这一步空产出' },
        { id: 'B', prompt: '依赖 A 的后续步', dependsOn: ['A'] },
      ],
    });
    const a = result.steps.find((step) => step.id === 'A');
    const b = result.steps.find((step) => step.id === 'B');
    assert.strictEqual(a?.ok, true, 'A 自身应记为成功');
    assert.strictEqual(a?.output, undefined, 'A 无产出');
    assert.strictEqual(b?.ok, true, '无产出的成功步骤不得让下游 fail-closed 跳过');
    assert.doesNotMatch(b?.error ?? '', /上游依赖失败/, 'B 不应被判依赖失败');
    assert.strictEqual(result.ok, true, '整体应成功');
  });
});

describe('并发闸门 fail-closed（非法上限即拒绝，绝不留永不放行的闸门）', () => {
  it('ConcurrencyLimiter 非法上限构造即抛 RangeError', () => {
    for (const bad of BAD_CONCURRENCY) {
      assert.throws(
        () => new ConcurrencyLimiter(bad as number),
        /并发上限非法/,
        `limit=${String(bad)} 会构造出永不放行的闸门`,
      );
    }
  });

  it('SubagentOrchestrator 非法 subagentConcurrency 构造即拒绝', () => {
    assert.throws(
      () =>
        new SubagentOrchestrator(
          makePorts(new EchoModel(), new RecordingEvents(), new RegistryToolPort()),
          { maxConcurrency: 0 },
        ),
      /subagentConcurrency/,
    );
  });
});
