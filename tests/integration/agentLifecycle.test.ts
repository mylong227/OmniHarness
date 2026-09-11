import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from '../../src/core/agent.js';
import { createRuntime } from '../../src/core/runtime.js';
import { ConfigFactory } from '../../src/config/configFactory.js';
import { MockModel } from '../../src/adapters/model/mockModel.js';
import { MemoryStorage } from '../../src/adapters/storage/memoryStorage.js';
import { AutoApproval } from '../../src/adapters/approval/autoApproval.js';
import { PlanApproval } from '../../src/adapters/approval/planApproval.js';
import { SilentEventPort } from '../../src/adapters/event/silentEventPort.js';
import { PassthroughSandbox } from '../../src/adapters/sandbox/passthroughSandbox.js';
import { CheckpointManager } from '../../src/core/checkpointManager.js';

/** 用固定端口组合构造 Agent（端到端，真实 IO）。 */
function buildAgent(approvals: AutoApproval | PlanApproval): Agent {
  const config = ConfigFactory.build({
    workspaceRoot: process.cwd(),
    maxSteps: 16,
    model: new MockModel(),
    storage: new MemoryStorage(),
    approvals,
    sandbox: new PassthroughSandbox(),
    events: new SilentEventPort(),
  });
  return new Agent(createRuntime(config));
}

test('集成：agent 默认循环跑通（模型→工具门禁→存储）', async () => {
  const agent = buildAgent(new AutoApproval());
  const result = await agent.runTask('测试工具调用');
  assert.ok(result.finalText !== undefined && result.finalText.length > 0);
  assert.ok(result.steps >= 2);
  assert.ok(
    result.events.some((e) => e.type === 'tool_call'),
    '应产生工具调用事件',
  );
  assert.ok(
    result.events.some((e) => e.type === 'tool_result'),
    '应产生工具结果事件',
  );
});

test('集成：CheckpointManager 经真实存储做事件快照/回滚往返', async () => {
  const storage = new MemoryStorage();
  const agent = buildAgent(new AutoApproval());
  const result = await agent.runTask('带检查点的任务');
  const sessionId = result.sessionId;

  // 快照当前事件日志。
  const mgr = new CheckpointManager(storage);
  const meta = await mgr.snapshot(sessionId, 'cp1');
  assert.strictEqual(meta.eventCount, (await storage.load(sessionId)).length);

  // 模拟会话偏离：用一条不同事件覆盖存储。
  await storage.save(sessionId, [
    { id: 'x', type: 'user', sessionId, timestamp: new Date().toISOString(), payload: {} },
  ] as never);
  assert.strictEqual((await storage.load(sessionId)).length, 1, '偏离已注入');

  // 回滚应还原到快照（事件数恢复）。
  const rolled = await mgr.rollback(sessionId, 'cp1');
  assert.strictEqual(rolled.label, 'cp1');
  assert.strictEqual((await storage.load(sessionId)).length, meta.eventCount, '回滚恢复事件数');
});

test('集成：plan 只读档端到端拦截可变工具', async () => {
  const agent = buildAgent(new PlanApproval());
  const result = await agent.runTask('只读规划任务');
  const denied = result.events.find((e) => e.type === 'tool_result');
  assert.notStrictEqual(denied, undefined, 'plan 模式下应产生工具结果事件');
  const payload = denied?.payload as { ok: boolean; error?: string };
  assert.strictEqual(payload.ok, false, `plan 模式应拒绝可变工具（${payload.error}）`);
});
