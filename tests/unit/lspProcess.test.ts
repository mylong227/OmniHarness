import { resolve } from 'node:path';
import { strict as assert } from 'node:assert/strict';
import { describe, test } from 'node:test';
import { LspProcessAdapter } from '../../src/adapters/lsp/lspProcessAdapter.js';
import { fileToUri } from '../../src/lsp/lspUri.js';
import { ConfigFactory } from '../../src/config/configFactory.js';
import { MockModel } from '../../src/adapters/model/mockModel.js';
import { MemoryStorage } from '../../src/adapters/storage/memoryStorage.js';

// 测试从项目根运行，mock 服务器为源码级 .mjs（不被 tsc 编译），故相对于项目根定位。
const mockServer = resolve(process.cwd(), 'tests/fixtures/mockLspServer.mjs');

/** 用当前 node 跑 mock LSP 服务器（进程级 JSON-RPC 实证，不依赖任何真实语言服务器）。 */
function adapter(): LspProcessAdapter {
  return new LspProcessAdapter({
    serverCommand: process.execPath,
    serverArgs: [mockServer],
    rootUri: fileToUri(process.cwd()),
  });
}

describe('LspProcessAdapter（进程级 JSON-RPC 接线）', () => {
  test('name 为 lsp-process', () => {
    assert.strictEqual(adapter().name, 'lsp-process');
  });

  test('definition：真实 spawn + 坐标 1-based→0-based→1-based 往返', async () => {
    const file = resolve(process.cwd(), 'some/file.ts');
    const a = adapter();
    try {
      const locs = await a.definition(file, 5, 3);
      assert.strictEqual(locs.length, 1);
      const first = locs[0];
      assert.ok(first !== undefined);
      // mock 返回 0-based line 0 → 适配器转回 1-based line 1。
      assert.strictEqual(first.range.start.line, 1);
      assert.strictEqual(first.range.start.character, 1);
      // file:// URI 被适配器转回普通路径（跨平台：Windows 下为反斜杠绝对路径）。
      assert.strictEqual(first.uri, file);
    } finally {
      await a.shutdown();
    }
  });

  test('references：返回全部引用（含声明处）', async () => {
    const a = adapter();
    try {
      const locs = await a.references('/some/file.ts', 1, 1);
      assert.strictEqual(locs.length, 2);
      const lines = locs.map((loc) => loc.range.start.line).sort((x, y) => x - y);
      assert.deepStrictEqual(lines, [1, 3]);
    } finally {
      await a.shutdown();
    }
  });

  test('hover：返回文档文本', async () => {
    const a = adapter();
    try {
      const doc = await a.hover('/some/file.ts', 2, 2);
      assert.strictEqual(doc, 'mock hover doc for symbol');
    } finally {
      await a.shutdown();
    }
  });

  test('文件不存在仍不崩（didOpen 读盘失败时发空文本）', async () => {
    const a = adapter();
    try {
      const locs = await a.definition('/no/such/file.ts', 1, 1);
      assert.strictEqual(locs.length, 1);
    } finally {
      await a.shutdown();
    }
  });

  test('shutdown 幂等（重复调用不抛）', async () => {
    const a = adapter();
    await a.definition('/some/file.ts', 1, 1);
    await a.shutdown();
    await a.shutdown();
  });
});

describe('LSP 配置接线（buildLsp + defaultTools 注册）', () => {
  test('配置了 lsp.serverCommand 时注册 4 个 LSP 工具', () => {
    const config = ConfigFactory.build({
      workspaceRoot: process.cwd(),
      maxSteps: 5,
      model: new MockModel(),
      storage: new MemoryStorage(),
      lspServer: { serverCommand: process.execPath, serverArgs: [mockServer] },
    });
    const names = config.tools.list().map((definition) => definition.name);
    assert.ok(names.includes('lsp_go_to_definition'));
    assert.ok(names.includes('lsp_find_references'));
    assert.ok(names.includes('lsp_hover'));
    assert.ok(names.includes('lsp_status'));
    assert.ok(config.lsp !== undefined);
  });

  test('未配置 lsp 时不注册 LSP 工具（主循环零侵入）', () => {
    const config = ConfigFactory.build({
      workspaceRoot: process.cwd(),
      maxSteps: 5,
      model: new MockModel(),
      storage: new MemoryStorage(),
    });
    const names = config.tools.list().map((definition) => definition.name);
    assert.ok(!names.includes('lsp_go_to_definition'));
    assert.ok(config.lsp === undefined);
  });
});
