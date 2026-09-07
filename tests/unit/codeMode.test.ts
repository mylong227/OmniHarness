import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CodeInterpreter } from '../../src/code/codeInterpreter.js';
import { CodeExecutorTool } from '../../src/code/codeExecutorTool.js';
import { ToolGate } from '../../src/core/toolGate.js';
import { RegistryToolPort } from '../../src/adapters/tool/registryToolPort.js';
import { AutoApproval } from '../../src/adapters/approval/autoApproval.js';
import { DenyApproval } from '../../src/adapters/approval/denyApproval.js';
import { PassthroughSandbox } from '../../src/adapters/sandbox/passthroughSandbox.js';
import type { ToolCall, ToolContext, ToolResult } from '../../src/ports/tool.js';

/** 测试上下文。 */
const context: ToolContext = { sessionId: 's1', workspaceRoot: process.cwd() };

/** 构造带 echo 工具的注册表。 */
function registryWith(extra?: (name: string, call: ToolCall) => ToolResult): RegistryToolPort {
  const registry = new RegistryToolPort();
  registry.register(
    {
      name: 'echo',
      description: '回显',
      parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    },
    async (call: ToolCall) => ({
      callId: call.id,
      ok: true,
      output: String(call.arguments['text'] ?? ''),
    }),
  );
  if (extra !== undefined) {
    registry.register(
      { name: 'boom', description: '抛错', parameters: { type: 'object', properties: {} } },
      async (call: ToolCall) => extra('boom', call),
    );
  }
  return registry;
}

test('CodeInterpreter：多次工具调用顺序执行', async () => {
  const interpreter = new CodeInterpreter();
  const registry = registryWith();
  const code = `
    const a = await call('echo', { text: '第一' });
    const b = await call('echo', { text: '第二' });
    log(a, '|', b);
    return '完成';
  `;
  const result = await interpreter.run(code, {
    execute: (call) => registry.execute(call, context),
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.calls, 2);
  assert.match(result.output, /第一 \| 第二/);
  assert.match(result.output, /返回值: "完成"/);
});

test('CodeInterpreter：工具失败抛出错误', async () => {
  const interpreter = new CodeInterpreter();
  const code = `
    await call('boom', {});
    return 'ok';
  `;
  const result = await interpreter.run(code, {
    execute: async (call) => ({ callId: call.id, ok: false, error: '模拟失败' }),
  });
  assert.strictEqual(result.ok, false);
  assert.match(result.output, /工具 boom 失败/);
});

test('CodeInterpreter：语法错误收敛为失败结果', async () => {
  const interpreter = new CodeInterpreter();
  const result = await interpreter.run('const = broken(', {
    execute: async () => ({ callId: 'x', ok: true }),
  });
  assert.strictEqual(result.ok, false);
  assert.match(result.output, /执行错误/);
});

test('CodeExecutorTool：程序内调用经门禁执行', async () => {
  const registry = registryWith();
  const coder = new CodeExecutorTool({
    gate: new ToolGate(new AutoApproval(), new PassthroughSandbox()),
    tools: registry,
  });
  const code = `const r = await call('echo', { text: 'ptc' }); log('拿到:', r);`;
  const result = await coder.handle({ id: 'c1', name: 'run_code', arguments: { code } }, context);
  assert.strictEqual(result.ok, true);
  assert.match(result.output ?? '', /拿到: ptc/);
});

test('CodeExecutorTool：审批拒绝时程序内调用被拦截', async () => {
  const registry = registryWith();
  const coder = new CodeExecutorTool({
    gate: new ToolGate(new DenyApproval(), new PassthroughSandbox()),
    tools: registry,
  });
  const code = `await call('echo', { text: 'x' });`;
  const result = await coder.handle({ id: 'c1', name: 'run_code', arguments: { code } }, context);
  assert.strictEqual(result.ok, false);
  assert.match(result.output ?? '', /工具 echo 失败/);
  // ToolGate 透传真实拒绝原因（plan/审批/沙箱），不再依赖旧字符串"被拒绝"。
  assert.match(result.output ?? '', /拒绝/);
});
