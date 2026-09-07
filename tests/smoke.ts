import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent } from '../src/core/agent.js';
import { RuntimeFactory } from '../src/core/runtime.js';
import { ConfigFactory } from '../src/config/omniharnessConfig.js';
import { MockModel } from '../src/adapters/model/mockModel.js';
import { MemoryStorage } from '../src/adapters/storage/memoryStorage.js';
import { JsonlStorage } from '../src/adapters/storage/jsonlStorage.js';
import { DenyApproval } from '../src/adapters/approval/denyApproval.js';
import { AutoApproval } from '../src/adapters/approval/autoApproval.js';
import { SilentEventPort } from '../src/adapters/event/silentEventPort.js';
import { PassthroughSandbox } from '../src/adapters/sandbox/passthroughSandbox.js';
import { RegistryToolPort } from '../src/adapters/tool/registryToolPort.js';
import type { ToolCall, ToolContext, ToolDefinition, ToolResult } from '../src/ports/tool.js';
import { works } from './assert.js';

/** 冒烟测试：端口-适配器架构下多种组合必须全部走通。 */
async function runSmoke(): Promise<void> {
  await testDefaultLoop();
  await testJsonlStorage();
  await testCustomTool();
  await testDenyApproval();
  process.stdout.write('\n冒烟测试全部通过 ✅\n');
}

/** A. 默认组合：mock 模型 + 内存存储 + auto 审批 + 直通沙箱。 */
async function testDefaultLoop(): Promise<void> {
  const agent = buildAgent(new MockModel(), new MemoryStorage(), new AutoApproval());
  const result = await agent.runTask('测试工具调用');

  works(result.finalText !== undefined, 'A. 模型输出最终文本');
  works(result.steps >= 2, `A. 回合步数 >= 2（实际 ${result.steps}）`);
  works(
    result.events.some((event) => event.type === 'tool_call'),
    'A. 含工具调用事件',
  );
  works(
    result.events.some((event) => event.type === 'tool_result'),
    'A. 含工具结果事件',
  );
}

/** B. JSONL 文件存储：会话事件必须落盘。 */
async function testJsonlStorage(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'omniharness-'));
  const agent = buildAgent(new MockModel(), new JsonlStorage(dir), new AutoApproval());
  const result = await agent.runTask('测试持久化');
  const file = join(dir, `${result.sessionId}.jsonl`);
  const content = await readFile(file, 'utf8');
  works(content.split('\n').length >= 5, `B. JSONL 落盘（${content.split('\n').length} 行）`);
  await rm(dir, { recursive: true, force: true });
}

/** C. 自定义工具插口：注册新工具即可用。 */
async function testCustomTool(): Promise<void> {
  const registry = new RegistryToolPort();
  const definition: ToolDefinition = {
    name: 'uppercase',
    description: '把文本转大写',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  };
  const handler = async (call: ToolCall, _ctx: ToolContext): Promise<ToolResult> => ({
    callId: call.id,
    ok: true,
    output: String(call.arguments['text'] ?? '').toUpperCase(),
  });
  registry.register(definition, handler);
  const result = await registry.execute(
    { id: 'c1', name: 'uppercase', arguments: { text: 'omniharness' } },
    { sessionId: 's1', workspaceRoot: process.cwd() },
  );
  works(
    result.ok === true && result.output === 'OMNIHARNESS',
    `C. 自定义工具生效（${result.output}）`,
  );
}

/** D. 拒绝型审批：工具调用必须被拦截。 */
async function testDenyApproval(): Promise<void> {
  const agent = buildAgent(new MockModel(), new MemoryStorage(), new DenyApproval());
  const result = await agent.runTask('测试审批拒绝');
  const denied = result.events.find((event) => event.type === 'tool_result');
  works(denied !== undefined, 'D. 产生工具结果事件');
  const payload = denied?.payload as { ok: boolean; error?: string };
  works(payload.ok === false, `D. 工具被拒绝（${payload.error}）`);
}

/** 构造 Agent（固定端口组合）。 */
function buildAgent(
  model: MockModel,
  storage: MemoryStorage | JsonlStorage,
  approvals: AutoApproval | DenyApproval,
): Agent {
  const config = ConfigFactory.build({
    workspaceRoot: process.cwd(),
    maxSteps: 16,
    model,
    storage,
    approvals,
    sandbox: new PassthroughSandbox(),
    events: new SilentEventPort(),
  });
  return new Agent(RuntimeFactory.create(config));
}

runSmoke().catch((error: unknown) => {
  console.error(`冒烟测试失败: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
