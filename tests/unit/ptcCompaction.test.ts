import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from '../../src/core/agent.js';
import { createRuntime } from '../../src/core/runtime.js';
import { ConfigFactory } from '../../src/config/configFactory.js';
import { MemoryStorage } from '../../src/adapters/storage/memoryStorage.js';
import { SilentEventPort } from '../../src/adapters/event/silentEventPort.js';
import { AutoApproval } from '../../src/adapters/approval/autoApproval.js';
import { PassthroughSandbox } from '../../src/adapters/sandbox/passthroughSandbox.js';
import { StressModel } from '../helpers/stressModel.js';
import { ptcScript } from '../helpers/ptcScript.js';

/** 读取事件 payload 字段（payload 类型为 unknown，需收敛）。 */
function fieldOf(event: { payload: unknown }, key: string): unknown {
  const payload = event.payload as Record<string, unknown> | undefined;
  return payload?.[key];
}

/** 构造组合链路配置（小预算强制触发压缩）。 */
function buildAgent(): Agent {
  const config = ConfigFactory.build({
    workspaceRoot: process.cwd(),
    maxSteps: 12,
    model: new StressModel(ptcScript()),
    storage: new MemoryStorage(),
    approvals: new AutoApproval(),
    sandbox: new PassthroughSandbox(),
    events: new SilentEventPort(),
    compactionMaxTokens: 60,
  });
  return new Agent(createRuntime(config));
}

test('PTC × 压缩：长会话触发压缩并记录 system 事件', async () => {
  const result = await buildAgent().runTask('组合链路');
  const system = result.events.filter((event) => event.type === 'system');
  assert.ok(system.length >= 1, '超预算应触发压缩');
  // 压缩事件可能排在开场记忆 primer 等其它 system 事件之后，须在所有 system 事件里检索。
  const hasCompactionEvent = system.some((event) =>
    /上下文压缩/.test(String(fieldOf(event, 'content') ?? '')),
  );
  assert.ok(hasCompactionEvent, '应记录上下文压缩点 system 事件');
});

test('PTC × 压缩：程序内多次工具调用全部成功', async () => {
  const result = await buildAgent().runTask('组合链路');
  const toolResults = result.events.filter((event) => event.type === 'tool_result');
  assert.strictEqual(toolResults.length, 5, '应有 5 次 run_code 结果');
  for (const event of toolResults) {
    assert.strictEqual(
      fieldOf(event, 'ok'),
      true,
      `run_code 应成功: ${String(fieldOf(event, 'error') ?? '')}`,
    );
  }
  const outputs = toolResults.map((event) => String(fieldOf(event, 'output') ?? '')).join('\n');
  assert.match(outputs, /ptc-1-0/, '程序内首次调用结果应在输出中');
  assert.match(outputs, /ptc-5-2/, '程序内末次调用结果应在输出中');
});

test('PTC × 压缩：压缩后回合仍能正常收尾', async () => {
  const result = await buildAgent().runTask('组合链路');
  assert.strictEqual(result.finalText, '组合压测完成');
  assert.ok(result.steps >= 6, `步数应覆盖 5 次 PTC + 收尾，实际 ${result.steps}`);
});
