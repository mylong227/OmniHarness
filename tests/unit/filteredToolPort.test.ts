// 受限工具端口（审计 §30 Gap ④）单元测试。
// 覆盖：list() 过滤未放行项；execute() 对未放行项 fail-closed 拒绝（不转发基端口）；
// listDirect/unregister 委托基端口。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FilteredToolPort } from '../../src/core/filteredToolPort.js';
import { RegistryToolPort } from '../../src/adapters/tool/registryToolPort.js';
import type { ToolCall, ToolContext, ToolPort, ToolResult } from '../../src/ports/tool/tool.js';

/** 构造含 read/write 两类工具的基端口。 */
function base(): RegistryToolPort {
  const registry = new RegistryToolPort();
  const blank = { type: 'object', properties: {}, required: [] } as const;
  registry.register(
    { name: 'read_file', description: '读', parameters: blank },
    async (c: ToolCall): Promise<ToolResult> => ({
      callId: c.id,
      ok: true,
      output: 'read',
    }),
  );
  registry.register(
    { name: 'write_file', description: '写', parameters: blank },
    async (c: ToolCall): Promise<ToolResult> => ({
      callId: c.id,
      ok: true,
      output: 'write',
    }),
  );
  return registry;
}

/** 受控上下文。 */
function ctx(): ToolContext {
  return { sessionId: 't', workspaceRoot: process.cwd() };
}

test('list()：仅返回放行项，剔除未放行工具', () => {
  const port = new FilteredToolPort(base(), (n) => n === 'read_file');
  const names = port.list().map((d) => d.name);
  assert.deepStrictEqual(names, ['read_file']);
});

test('execute()：放行项委托基端口执行', async () => {
  const port = new FilteredToolPort(base(), (n) => n === 'read_file');
  const res = await port.execute({ id: 'c1', name: 'read_file', arguments: {} }, ctx());
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.output, 'read');
});

test('execute()：未放行项 fail-closed 拒绝（不转发基端口）', async () => {
  const port = new FilteredToolPort(base(), (n) => n === 'read_file');
  const res = await port.execute({ id: 'c2', name: 'write_file', arguments: {} }, ctx());
  assert.strictEqual(res.ok, false);
  assert.match(res.error ?? '', /受限子集|不在受限/);
});

test('listDirect()：与 list() 同视图——按谓词过滤（2026-10-03 修授权旁路，旧实现透传未过滤全量）', () => {
  const port = new FilteredToolPort(base(), (n) => n === 'read_file');
  // RegistryToolPort 实现 listDirect；effectiveTools() 优先取 listDirect，若透传全量，
  // 受限视图（A2A 委托/子代）的模型工具面会看到被禁工具的完整 schema。
  const direct = port.listDirect();
  assert.deepStrictEqual(
    direct.map((d) => d.name),
    ['read_file'],
  );
});

test('listDirect()：基端口未实现 listDirect 时回退受限 list（行为不变）', () => {
  const inner = base();
  const plain: ToolPort = {
    name: 'plain',
    list: () => inner.list().filter((d) => d.name === 'read_file'),
    async execute(): Promise<ToolResult> {
      return { callId: 'x', ok: true };
    },
  };
  const port = new FilteredToolPort(plain, (n) => n === 'read_file');
  assert.deepStrictEqual(
    port.listDirect().map((d) => d.name),
    ['read_file'],
  );
});

test('unregister()：委托基端口', () => {
  const registry = base();
  const port = new FilteredToolPort(registry, () => true);
  assert.strictEqual(port.unregister('read_file'), true);
  assert.strictEqual(
    port.list().some((d) => d.name === 'read_file'),
    false,
  );
});
