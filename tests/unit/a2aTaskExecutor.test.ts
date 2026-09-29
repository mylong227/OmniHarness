// A2A 任务委托执行器（审计 §30 Gap ④）单元测试。
// 覆盖：受限工具子集（剔除写类 / 危险工具 + 委托授权子集取交集）、并发闸门（有界）、
// 异常收敛为 ok:false。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { A2aTaskExecutor, type AgentRunner, type SubagentBuilder } from '../../src/a2a/a2aTaskExecutor.js';
import { RegistryToolPort } from '../../src/adapters/tool/registryToolPort.js';
import { MUTATING_TOOLS } from '../../src/core/toolGate.js';
import type { OmniHarnessRuntime } from '../../src/composition/runtime.js';
import type { EventPort } from '../../src/ports/runtime/eventPort.js';
import type { ToolPort } from '../../src/ports/tool/tool.js';
import type { DelegateRequest } from '../../src/a2a/a2aProtocol.js';

/** 构造含 read/write/shell 三类工具的基端口（write/shell 属 MUTATING_TOOLS）。 */
function baseTools(): RegistryToolPort {
  const registry = new RegistryToolPort();
  const blank = { type: 'object', properties: {}, required: [] } as const;
  for (const name of ['read_file', 'write_file', 'shell'] as const) {
    registry.register({ name, description: name, parameters: blank }, async (c) => ({
      callId: c.id,
      ok: true,
      output: name,
    }));
  }
  return registry;
}

/** 最小 fake runtime（仅消费 config.maxSteps / tools / events）。 */
function fakeRuntime(tools: ToolPort, events: EventPort): OmniHarnessRuntime {
  return {
    config: { maxSteps: 16 } as unknown as OmniHarnessRuntime['config'],
    tools,
    events,
  } as unknown as OmniHarnessRuntime;
}

const noopEvents: EventPort = { name: 'noop', emit() {} };

test('受限工具子集：剔除 MUTATING_TOOLS（写类/危险工具不暴露给对等方）', async () => {
  let captured: ToolPort | undefined;
  const buildSubagent: SubagentBuilder = (ports, tools) => {
    captured = tools;
    return {} as OmniHarnessRuntime;
  };
  const runTask: AgentRunner = async () => ({ finalText: 'done', steps: 1 });
  const ex = new A2aTaskExecutor(fakeRuntime(baseTools(), noopEvents), { buildSubagent, runTask });
  const result = await ex.handle({ taskId: 't1', task: 'do something' } as DelegateRequest);
  assert.strictEqual(result.ok, true);
  assert.ok(captured, 'buildSubagent 应收到受限工具端口');
  const exposed = captured!.list().map((d) => d.name);
  assert.deepStrictEqual(exposed, ['read_file'], '应只暴露非写类工具');
  assert.strictEqual(MUTATING_TOOLS.has('write_file'), true);
  assert.strictEqual(MUTATING_TOOLS.has('shell'), true);
});

test('受限工具子集：委托声明 tools 子集取交集（授权外工具不暴露）', async () => {
  let captured: ToolPort | undefined;
  const buildSubagent: SubagentBuilder = (ports, tools) => {
    captured = tools;
    return {} as OmniHarnessRuntime;
  };
  const runTask: AgentRunner = async () => ({ finalText: 'done', steps: 1 });
  const ex = new A2aTaskExecutor(fakeRuntime(baseTools(), noopEvents), { buildSubagent, runTask });
  // 即便委托方声明了 write_file，受限视图仍须剔除（写类优先于授权）。
  await ex.handle({ taskId: 't2', task: 'x', tools: ['read_file', 'write_file'] } as DelegateRequest);
  const exposed = captured!.list().map((d) => d.name);
  assert.deepStrictEqual(exposed, ['read_file'], '授权子集与「非写类」取交集');
});

test('并发闸门：默认上限 4，突发委托受有界（peak ≤ 上限）', async () => {
  let active = 0;
  let peak = 0;
  const runTask: AgentRunner = async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 40));
    active -= 1;
    return { finalText: 'ok', steps: 1 };
  };
  const buildSubagent: SubagentBuilder = () => ({}) as OmniHarnessRuntime;
  const ex = new A2aTaskExecutor(
    fakeRuntime(baseTools(), noopEvents),
    { buildSubagent, runTask, maxConcurrency: 2 },
  );
  const reqs = Array.from({ length: 6 }, (_, i) => ex.handle({ taskId: `c${i}`, task: 'x' } as DelegateRequest));
  await Promise.all(reqs);
  assert.ok(peak <= 2, `并发峰值应被闸门限制在 ≤2（实际 ${peak}）`);
  assert.ok(peak >= 2, `闸门应确实生效（峰值实际 ${peak}，说明并发过松或调度未重叠）`);
});

test('异常收敛：子代理抛错不向对等方抛协议错误，转为 ok:false', async () => {
  const buildSubagent: SubagentBuilder = () => ({}) as OmniHarnessRuntime;
  const runTask: AgentRunner = async () => {
    throw new Error('子代理内部故障');
  };
  const ex = new A2aTaskExecutor(fakeRuntime(baseTools(), noopEvents), { buildSubagent, runTask });
  const result = await ex.handle({ taskId: 't3', task: 'x' } as DelegateRequest);
  assert.strictEqual(result.ok, false);
  assert.match(result.error ?? '', /子代理内部故障/);
});
