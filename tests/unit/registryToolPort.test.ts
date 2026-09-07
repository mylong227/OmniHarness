import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RegistryToolPort } from '../../src/adapters/tool/registryToolPort.js';
import type { ToolCall, ToolDefinition, ToolResult } from '../../src/ports/tool.js';

/** 构造简单测试工具。 */
function echoTool(): { registry: RegistryToolPort; definition: ToolDefinition } {
  const registry = new RegistryToolPort();
  const definition: ToolDefinition = {
    name: 'echo',
    description: '回显文本',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
  };
  const handler = async (call: ToolCall): Promise<ToolResult> => ({
    callId: call.id,
    ok: true,
    output: String(call.arguments['text'] ?? ''),
  });
  registry.register(definition, handler);
  return { registry, definition };
}

/** 默认工具上下文。 */
const context = { sessionId: 's1', workspaceRoot: process.cwd() };

test('工具注册：正常执行返回结果', async () => {
  const { registry } = echoTool();
  const result = await registry.execute(
    { id: 'c1', name: 'echo', arguments: { text: '你好' } },
    context,
  );
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.output, '你好');
});

test('工具校验：缺少必填参数被拦截', async () => {
  const { registry } = echoTool();
  const result = await registry.execute({ id: 'c1', name: 'echo', arguments: {} }, context);
  assert.strictEqual(result.ok, false);
  assert.match(result.error ?? '', /缺少必填参数/);
});

test('工具校验：参数类型不符被拦截', async () => {
  const { registry } = echoTool();
  const result = await registry.execute(
    { id: 'c1', name: 'echo', arguments: { text: 123 } },
    context,
  );
  assert.strictEqual(result.ok, false);
  assert.match(result.error ?? '', /类型不符/);
});

test('工具执行：未知工具返回失败', async () => {
  const { registry } = echoTool();
  const result = await registry.execute({ id: 'c1', name: 'nope', arguments: {} }, context);
  assert.strictEqual(result.ok, false);
  assert.match(result.error ?? '', /未知工具/);
});

test('工具注册：重复注册抛错', () => {
  const { registry, definition } = echoTool();
  assert.throws(
    () => registry.register(definition, async () => ({ callId: 'x', ok: true })),
    /重复注册/,
  );
});

test('工具执行：处理函数抛错收敛为失败结果', async () => {
  const registry = new RegistryToolPort();
  registry.register(
    { name: 'boom', description: '抛错工具', parameters: { type: 'object', properties: {} } },
    async () => {
      throw new Error('内部爆炸');
    },
  );
  const result = await registry.execute({ id: 'c1', name: 'boom', arguments: {} }, context);
  assert.strictEqual(result.ok, false);
  assert.match(result.error ?? '', /内部爆炸/);
});

test('工具列表：返回全部定义', () => {
  const { registry } = echoTool();
  assert.strictEqual(registry.list().length, 1);
  assert.strictEqual(registry.list()[0]?.name, 'echo');
});
