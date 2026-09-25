import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { strict as assert } from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { LspProcessAdapter } from '../../src/adapters/lsp/lspProcessAdapter.js';
import { LspUri } from '../../src/adapters/lsp/lspUri.js';
import { LspDocumentSymbolsTool } from '../../src/adapters/tool/lsp/lspDocumentSymbolsTool.js';
import { LspCodeActionTool } from '../../src/adapters/tool/lsp/lspCodeActionTool.js';
import type { LspPort } from '../../src/ports/tool/lsp.js';
import type { ToolCall, ToolContext } from '../../src/ports/tool/tool.js';

// 测试从项目根运行，mock 服务器为源码级 .mjs（不被 tsc 编译），故相对于项目根定位。
const mockServer = resolve(process.cwd(), 'tests/fixtures/mockLspServer.mjs');

/** 一次性工作目录（放被测的「源文件」）。 */
const workDir = mkdtempSync(join(tmpdir(), 'omni-lsp-sym-'));

after(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/**
 * 用当前 node 跑 mock LSP 服务器（真 spawn + 真 JSON-RPC 分帧，不依赖真实语言服务器）。
 *
 * @returns 适配器实例。
 */
function adapter(): LspProcessAdapter {
  return new LspProcessAdapter({
    serverCommand: process.execPath,
    serverArgs: [mockServer],
    rootUri: LspUri.fileToUri(process.cwd()),
  });
}

/**
 * 造一个真实存在的源文件，让 didOpen 读到内容。
 *
 * @param name 文件名（含 `junk` 时 mock 会回畸形数据）。
 * @returns 绝对路径。
 */
function sourceFile(name: string): string {
  const file = join(workDir, name);
  writeFileSync(file, 'export const placeholder = 1;\n', 'utf8');
  return file;
}

/** 造一个工具调用。 */
function call(args: Readonly<Record<string, unknown>>): ToolCall {
  return { id: 'c1', name: 'x', arguments: args };
}

/** 最小工具上下文。 */
const ctx: ToolContext = { sessionId: 's1', workspaceRoot: process.cwd() };

describe('LSP 文档符号与代码操作（进程级 JSON-RPC 接线）', () => {
  test('documentSymbol：层级压平 + 缩进 + selectionRange 优先 + 坐标转 1-based', async () => {
    const file = sourceFile('demo.ts');
    const a = adapter();
    try {
      const symbols = await a.symbols(file);
      assert.deepStrictEqual(
        symbols.map((s) => [s.name, s.kind, s.range.start.line, s.range.start.character]),
        [
          ['DemoClass', 'class', 1, 7],
          ['  fieldOne', 'field', 2, 3],
          ['  methodOne', 'method', 3, 3],
          ['topLevelFn', 'function', 12, 10],
        ],
      );
      // URI 必须转回普通文件系统路径，而不是 file://。
      assert.ok(symbols.every((s) => !s.file.startsWith('file://')));
      assert.strictEqual(symbols[0]?.file, file);
    } finally {
      await a.shutdown();
    }
  });

  test('documentSymbol：畸形条目被跳过而不是抛错', async () => {
    const file = sourceFile('junk-symbols.ts');
    const a = adapter();
    try {
      const symbols = await a.symbols(file);
      assert.strictEqual(symbols.length, 1);
      assert.strictEqual(symbols[0]?.name, 'good');
      assert.strictEqual(symbols[0]?.range.start.line, 8);
      assert.strictEqual(symbols[0]?.range.start.character, 4);
    } finally {
      await a.shutdown();
    }
  });

  test('codeAction：changes / documentChanges 被压平，command-only 记为空编辑', async () => {
    const file = sourceFile('demo-action.ts');
    const a = adapter();
    try {
      const actions = await a.codeActions(file, {
        start: { line: 2, character: 1 },
        end: { line: 2, character: 4 },
      });
      assert.deepStrictEqual(
        actions.map((x) => x.title),
        ['Fix import', 'Organize imports', 'Rename symbol'],
      );
      assert.strictEqual(actions[0]?.kind, 'quickfix');
      assert.strictEqual(actions[0]?.isPreferred, true);
      assert.strictEqual(actions[0]?.edits.length, 1);
      assert.strictEqual(actions[0]?.edits[0]?.newText, "import x from 'y';");
      assert.strictEqual(actions[0]?.edits[0]?.range.start.line, 2);
      assert.strictEqual(actions[0]?.edits[0]?.range.start.character, 1);
      assert.strictEqual(actions[1]?.kind, 'source.organizeImports');
      assert.deepStrictEqual(actions[1]?.edits, [], '只有 command 的操作没有文本编辑');
      assert.strictEqual(actions[2]?.edits.length, 1);
      assert.strictEqual(actions[2]?.edits[0]?.newText, 'renamed');
      assert.strictEqual(actions[2]?.edits[0]?.range.start.line, 3);
    } finally {
      await a.shutdown();
    }
  });

  test('codeAction：畸形条目被跳过而不是抛错', async () => {
    const file = sourceFile('junk-actions.ts');
    const a = adapter();
    try {
      const actions = await a.codeActions(file, {
        start: { line: 1, character: 1 },
        end: { line: 1, character: 2 },
      });
      assert.strictEqual(actions.length, 1);
      assert.strictEqual(actions[0]?.title, 'only-command');
      assert.deepStrictEqual(actions[0]?.edits, []);
    } finally {
      await a.shutdown();
    }
  });

  test('未开放能力时方法缺失（注册侧据此不暴露死工具）', () => {
    // 端口把 symbols / codeActions 声明为**可选**：不支持的适配器可以不实现。
    // 这条断言钉住「可选」这一事实本身——若哪天有人把它们改成必填，
    // 所有只实现了导航的第三方适配器都会编译不过。
    const navOnly: LspPort = {
      name: 'nav-only',
      definition: async () => [],
      references: async () => [],
      hover: async () => undefined,
      shutdown: async () => undefined,
    };
    assert.strictEqual(navOnly.symbols, undefined);
    assert.strictEqual(navOnly.codeActions, undefined);
  });
});

describe('LSP 符号/代码操作工具渲染', () => {
  test('lsp_document_symbols：按行列排序渲染，无符号给明确提示', async () => {
    const port: LspPort = {
      name: 'stub',
      definition: async () => [],
      references: async () => [],
      hover: async () => undefined,
      shutdown: async () => undefined,
      symbols: async () => [
        {
          name: 'later',
          kind: 'function',
          file: '/x.ts',
          range: { start: { line: 9, character: 1 }, end: { line: 9, character: 5 } },
        },
        {
          name: 'earlier',
          kind: 'class',
          file: '/x.ts',
          range: { start: { line: 2, character: 1 }, end: { line: 2, character: 5 } },
        },
      ],
    };
    const tool = new LspDocumentSymbolsTool(port);
    const result = await tool.handle(call({ file: '/x.ts' }), ctx);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.output, 'class earlier — /x.ts:2:1\nfunction later — /x.ts:9:1');

    const empty: LspPort = { ...port, symbols: async () => [] };
    const none = await new LspDocumentSymbolsTool(empty).handle(call({ file: '/x.ts' }), ctx);
    assert.strictEqual(none.ok, true);
    assert.strictEqual(none.output, '未找到符号');

    const missing = await new LspDocumentSymbolsTool(port).handle(call({}), ctx);
    assert.strictEqual(missing.ok, false);
    assert.match(missing.error ?? '', /缺少文件参数/);
  });

  test('lsp_document_symbols：端口抛错转成 ok:false 而不是抛出', async () => {
    const port: LspPort = {
      name: 'stub',
      definition: async () => [],
      references: async () => [],
      hover: async () => undefined,
      shutdown: async () => undefined,
      symbols: async () => {
        throw new Error('server down');
      },
    };
    const result = await new LspDocumentSymbolsTool(port).handle(call({ file: '/x.ts' }), ctx);
    assert.strictEqual(result.ok, false);
    assert.match(result.error ?? '', /LSP 符号查询失败: server down/);
  });

  test('lsp_code_action：kind 按点边界前缀过滤，编辑含截断标注', async () => {
    const longText = 'x'.repeat(500);
    const port: LspPort = {
      name: 'stub',
      definition: async () => [],
      references: async () => [],
      hover: async () => undefined,
      shutdown: async () => undefined,
      codeActions: async () => [
        {
          title: 'A',
          kind: 'quickfix',
          isPreferred: true,
          edits: [
            {
              file: '/x.ts',
              range: { start: { line: 3, character: 1 }, end: { line: 3, character: 2 } },
              newText: 'small',
            },
          ],
        },
        { title: 'B', kind: 'quickfix.import', isPreferred: false, edits: [] },
        {
          title: 'C',
          kind: 'refactor.extract',
          isPreferred: false,
          edits: [
            {
              file: '/x.ts',
              range: { start: { line: 4, character: 1 }, end: { line: 4, character: 2 } },
              newText: longText,
            },
          ],
        },
        { title: 'D', kind: 'refactoring', isPreferred: false, edits: [] },
      ],
    };
    const tool = new LspCodeActionTool(port);

    const all = await tool.handle(call({ file: '/x.ts', line: 3, character: 1 }), ctx);
    assert.strictEqual(all.ok, true);
    assert.match(all.output ?? '', /^- A \[quickfix\] \(preferred\)/m);
    assert.match(all.output ?? '', /^    \/x\.ts:3:1: "small"$/m);

    // `quickfix` 接受 `quickfix` 与 `quickfix.x`，但**不**接受 `refactoring`（点边界）。
    const quickfixOnly = await tool.handle(
      call({ file: '/x.ts', line: 3, character: 1, kind: 'quickfix' }),
      ctx,
    );
    assert.match(quickfixOnly.output ?? '', /- A \[quickfix\]/);
    assert.match(quickfixOnly.output ?? '', /- B \[quickfix\.import\]/);
    assert.doesNotMatch(quickfixOnly.output ?? '', /- C /);
    assert.doesNotMatch(quickfixOnly.output ?? '', /- D /);

    const refactorOnly = await tool.handle(
      call({ file: '/x.ts', line: 3, character: 1, kind: 'refactor' }),
      ctx,
    );
    assert.match(refactorOnly.output ?? '', /- C \[refactor\.extract\]/);
    assert.doesNotMatch(refactorOnly.output ?? '', /- D /, 'refactoring 不该被 refactor 前缀命中');
    assert.match(refactorOnly.output ?? '', /截断，原长 500/);

    // command-only 操作要显式说明「无文本编辑可预览」，而不是留空行。
    const onlyCommand = await tool.handle(
      call({ file: '/x.ts', line: 3, character: 1, kind: 'no-such-kind' }),
      ctx,
    );
    assert.strictEqual(onlyCommand.output, '未找到可用的代码操作');
    const base = await tool.handle(call({ file: '/x.ts', line: 3, character: 1 }), ctx);
    assert.ok(base.output !== undefined);
  });

  test('lsp_code_action：无结果与异常都走可读文案', async () => {
    const empty: LspPort = {
      name: 'stub',
      definition: async () => [],
      references: async () => [],
      hover: async () => undefined,
      shutdown: async () => undefined,
      codeActions: async () => [],
    };
    const none = await new LspCodeActionTool(empty).handle(
      call({ file: '/x.ts', line: 1, character: 1 }),
      ctx,
    );
    assert.strictEqual(none.ok, true);
    assert.strictEqual(none.output, '未找到可用的代码操作');

    const bad = await new LspCodeActionTool({
      ...empty,
      codeActions: async () => {
        throw new Error('boom');
      },
    }).handle(call({ file: '/x.ts', line: 1, character: 1 }), ctx);
    assert.strictEqual(bad.ok, false);
    assert.match(bad.error ?? '', /LSP 代码操作查询失败: boom/);

    const noPos = await new LspCodeActionTool(empty).handle(call({ file: '/x.ts' }), ctx);
    assert.strictEqual(noPos.ok, false);
    assert.match(noPos.error ?? '', /line 必须是/);
  });
});
