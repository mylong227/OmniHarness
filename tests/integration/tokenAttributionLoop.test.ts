/**
 * P5 per-tool token 归因集成测试（走生产装配路径 + 真实 Agent 循环）。
 *
 * 用一个「带 usage 的脚本化模型」真跑一轮 Agent（模型 → 工具门禁 → 执行 → 记录），
 * 捕获**运行时真发出的事件**，再对其做归因投影。断言归因结果与真实 usage 一致——
 * 证明归因消费的是生产事实源，而非自造的假事件。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from '../../src/core/agent.js';
import { Runtime } from '../../src/composition/runtime.js';
import { ConfigFactory } from '../../src/config/configFactory.js';
import { MemoryStorage } from '../../src/adapters/storage/memoryStorage.js';
import { AutoApproval } from '../../src/adapters/approval/autoApproval.js';
import { PassthroughSandbox } from '../../src/adapters/sandbox/passthroughSandbox.js';
import { TokenAttribution, INITIAL_BUCKET } from '../../src/observability/tokenAttribution.js';
import type { EventPort } from '../../src/ports/runtime/eventPort.js';
import type { SessionEvent } from '../../src/ports/runtime/event.js';
import type { ModelOutput, ModelPort } from '../../src/ports/model/model.js';
import { tempWorkspace } from '../helpers/tempWorkspace.js';

/** 捕获型事件端口替身：保留运行时真发出的全部事件（供归因投影）。 */
class CapturingEventPort implements EventPort {
  /** 端口名。 */
  public readonly name = 'capture';
  /** 已捕获的事件（按发出顺序）。 */
  public readonly events: SessionEvent[] = [];

  /**
   * 捕获一条事件。
   * @param event 运行时发出的事件。
   * @returns 无返回值。
   */
  public emit(event: SessionEvent): void {
    this.events.push(event);
  }
}

/** 带 usage 的脚本化模型：首步回工具调用、次步回文本，两步都上报 token 用量。 */
class UsageModel implements ModelPort {
  /** 端口名。 */
  public readonly name = 'usage-model';
  /** 已调用次数（决定脚本走向）。 */
  private calls = 0;

  /**
   * 生成响应（脚本化）。
   * @returns 首步为 shell 工具调用，其余为最终文本；均带固定 usage。
   */
  public async generate(): Promise<ModelOutput> {
    this.calls += 1;
    if (this.calls === 1) {
      return {
        toolCalls: [{ id: 't1', name: 'shell', arguments: { command: 'echo hi' } }],
        usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
      };
    }
    return {
      text: '完成',
      usage: { promptTokens: 300, completionTokens: 40, totalTokens: 340 },
    };
  }
}

test('集成：真实运行事件流 → per-tool 归因与 usage 一致', async () => {
  const events = new CapturingEventPort();
  const config = ConfigFactory.build({
    workspaceRoot: tempWorkspace(),
    maxSteps: 4,
    model: new UsageModel(),
    storage: new MemoryStorage(),
    approvals: new AutoApproval(),
    sandbox: new PassthroughSandbox(),
    events,
  });
  const agent = new Agent(Runtime.createRuntime(config));
  await agent.runTask('跑一次工具回路');

  const modelEvents = events.events.filter((e) => e.type === 'model');
  const toolCalls = events.events.filter((e) => e.type === 'tool_call');
  assert.strictEqual(modelEvents.length, 2, '两步各发一条 model 事件');
  assert.strictEqual(toolCalls.length, 1, '首步发起一次 shell 工具调用');

  const report = TokenAttribution.fromEvents(events.events);
  assert.strictEqual(report.modelCallsWithUsage, 2);
  assert.strictEqual(report.modelCallsWithoutUsage, 0);

  const byTool = new Map(report.buckets.map((b) => [b.tool, b]));
  assert.strictEqual(byTool.get(INITIAL_BUCKET)?.totalTokens, 120, '首步无前驱工具 ⇒ <initial>');
  assert.strictEqual(byTool.get('shell')?.totalTokens, 340, '次步摄取了 shell 结果 ⇒ 归 shell');
  assert.strictEqual(byTool.get('shell')?.toolCalls, 1);
  assert.strictEqual(report.totalTokens, 460, '归因总量守恒');
});
