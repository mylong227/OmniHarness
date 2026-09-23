import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent } from '../../src/core/agent.js';
import { createRuntime } from '../../src/composition/runtime.js';
import { ConfigFactory } from '../../src/config/configFactory.js';
import { MockModel } from '../../src/adapters/model/mockModel.js';
import { MemoryStorage } from '../../src/adapters/storage/memoryStorage.js';
import { JsonlStorage } from '../../src/adapters/storage/jsonlStorage.js';
import { SilentEventPort } from '../../src/adapters/event/silentEventPort.js';
import { AutoApproval } from '../../src/adapters/approval/autoApproval.js';
import { PassthroughSandbox } from '../../src/adapters/sandbox/passthroughSandbox.js';

/** 构造 Agent（内存存储）。 */
function buildAgent(storage: MemoryStorage | JsonlStorage): Agent {
  const config = ConfigFactory.build({
    workspaceRoot: process.cwd(),
    maxSteps: 16,
    model: new MockModel(),
    storage,
    approvals: new AutoApproval(),
    sandbox: new PassthroughSandbox(),
    events: new SilentEventPort(),
  });
  return new Agent(createRuntime(config));
}

test('会话：resume 沿用同一 sessionId 且保留历史', async () => {
  const storage = new MemoryStorage();
  const agent = buildAgent(storage);
  const first = await agent.runTask('第一次任务');
  const second = await agent.resume(first.sessionId, '继续做');

  assert.strictEqual(second.sessionId, first.sessionId);
  assert.ok(second.events.length > first.events.length, 'resume 后事件更多');
  assert.strictEqual(second.events[0]?.payload, first.events[0]?.payload, '历史事件原样保留');
});

test('会话：fork 生成新会话且原会话不受影响', async () => {
  const storage = new MemoryStorage();
  const agent = buildAgent(storage);
  const original = await agent.runTask('原始任务');
  const before = (await storage.load(original.sessionId)).length;

  const branch = await agent.fork(original.sessionId, '换个方向');
  const after = (await storage.load(original.sessionId)).length;

  assert.notStrictEqual(branch.sessionId, original.sessionId);
  assert.strictEqual(after, before, '原会话事件数不变');
  assert.ok(branch.events.length >= before, '分叉含历史事件');
});

test('会话：replay 返回全部事件', async () => {
  const storage = new MemoryStorage();
  const agent = buildAgent(storage);
  const first = await agent.runTask('回放测试');

  const replayed = await agent.replay(first.sessionId);
  assert.strictEqual(replayed.length, first.events.length);
});

test('会话：不存在会话 resume 为空历史起步', async () => {
  const storage = new MemoryStorage();
  const agent = buildAgent(storage);
  const result = await agent.resume('missing_sess', '新问题');
  assert.strictEqual(result.sessionId, 'missing_sess');
  assert.ok(result.events.length >= 1);
});

test('存储：JSONL 保存后可完整加载', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omniharness-'));
  const storage = new JsonlStorage(dir);
  const agent = buildAgent(storage);
  const first = await agent.runTask('持久化生命周期');

  const loaded = await storage.load(first.sessionId);
  assert.strictEqual(loaded.length, first.events.length);
  assert.deepStrictEqual(loaded, first.events);

  await rm(dir, { recursive: true, force: true });
});

test('存储：加载不存在的会话返回空', async () => {
  const storage = new MemoryStorage();
  assert.deepStrictEqual(await storage.load('nope'), []);
});
