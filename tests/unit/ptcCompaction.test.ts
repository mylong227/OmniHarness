import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from '../../src/core/agent.js';
import { Runtime } from '../../src/composition/runtime.js';
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
  // 关闭 repo-map 注入：本测试只验证「长会话触发压缩并记录 system 事件」，
  // 与 repo-map（每轮动态、不参与历史压缩预算）解耦。P_prefix 治理后 repo-map
  // 移至消息尾部、不再计入 compactor 输入，故此处显式关掉，避免压缩触发依赖于
  // repo-map 的 token 量（否则会隐式耦合两个正交能力）。
  process.env.OMNI_REPO_MAP = '0';
  const config = ConfigFactory.build({
    workspaceRoot: process.cwd(),
    maxSteps: 12,
    model: new StressModel(ptcScript()),
    storage: new MemoryStorage(),
    approvals: new AutoApproval(),
    sandbox: new PassthroughSandbox(),
    events: new SilentEventPort(),
    // 小预算强制触发压缩：P_prefix 治理后 repo-map 移至消息尾部、不再计入 compactor 输入，
    // 故此处预算须低于「脚本历史本身」的 token 量（~70+），与 repo-map 解耦。30 稳定低于该量。
    compactionMaxTokens: 30,
  });
  return new Agent(Runtime.createRuntime(config));
}

test('PTC × 压缩：长会话触发压缩并记录 system 事件', async () => {
  const result = await buildAgent().runTask('组合链路');
  const system = result.events.filter((event) => event.type === 'system');
  assert.ok(system.length >= 1, '超预算应触发压缩');
  // 压缩事件可能排在开场记忆 primer 等其它 system 事件之后，须在所有 system 事件里检索。
  const hasCompactionEvent = system.some((event) =>
    /OMNI_COMPACTION_V1|上下文压缩/.test(String(fieldOf(event, 'content') ?? '')),
  );
  assert.ok(
    hasCompactionEvent,
    '应记录压缩点 system 事件（OMNI_COMPACTION_V1 游标或 上下文压缩 标记）',
  );
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
