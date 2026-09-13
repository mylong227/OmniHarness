import { strict as assert } from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { LspLocation, LspPort } from '../../src/ports/tool/lsp.js';
import {
  LspFindReferencesTool,
  LspGoToDefinitionTool,
  LspHoverTool,
  LspStatusTool,
} from '../../src/adapters/tool/lsp/lspTools.js';

const SAMPLE: LspLocation = {
  uri: '/proj/src/x.ts',
  range: { start: { line: 1, character: 2 }, end: { line: 1, character: 8 } },
};

/** 内存假 LSP：可选 ok / empty 两种模式，验证工具渲染与边界。 */
class FakeLsp implements LspPort {
  public readonly name = 'fake-lsp';
  public constructor(private readonly mode: 'ok' | 'empty' = 'ok') {}
  public async definition(): Promise<readonly LspLocation[]> {
    return this.mode === 'ok' ? [SAMPLE] : [];
  }
  public async references(): Promise<readonly LspLocation[]> {
    return this.mode === 'ok' ? [SAMPLE, SAMPLE] : [];
  }
  public async hover(): Promise<string | undefined> {
    return this.mode === 'ok' ? 'doc for symbol' : undefined;
  }
  public async shutdown(): Promise<void> {
    /* noop */
  }
}

const CTX = { sessionId: 't', workspaceRoot: process.cwd() } as const;

describe('LspGoToDefinitionTool', () => {
  test('命中返回 file:line:col', async () => {
    const out = await new LspGoToDefinitionTool(new FakeLsp()).handle(
      {
        id: 'c1',
        name: 'lsp_go_to_definition',
        arguments: { file: '/proj/src/x.ts', line: 10, character: 4 },
      },
      CTX,
    );
    assert.strictEqual(out.ok, true);
    assert.match(String(out.output), /\/proj\/src\/x\.ts:1:2/);
  });
  test('未命中返回「未找到定义」', async () => {
    const out = await new LspGoToDefinitionTool(new FakeLsp('empty')).handle(
      {
        id: 'c2',
        name: 'lsp_go_to_definition',
        arguments: { file: '/p/x.ts', line: 1, character: 1 },
      },
      CTX,
    );
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.output, '未找到定义');
  });
  test('缺 file 参数返回错误', async () => {
    const out = await new LspGoToDefinitionTool(new FakeLsp()).handle(
      { id: 'c3', name: 'lsp_go_to_definition', arguments: { line: 1, character: 1 } },
      CTX,
    );
    assert.strictEqual(out.ok, false);
    assert.match(String(out.error), /file/);
  });
  test('line 非正整数返回错误', async () => {
    const out = await new LspGoToDefinitionTool(new FakeLsp()).handle(
      {
        id: 'c4',
        name: 'lsp_go_to_definition',
        arguments: { file: '/p/x.ts', line: 0, character: 1 },
      },
      CTX,
    );
    assert.strictEqual(out.ok, false);
    assert.match(String(out.error), /line/);
  });
});

describe('LspFindReferencesTool', () => {
  test('命中返回全部引用（含声明）', async () => {
    const out = await new LspFindReferencesTool(new FakeLsp()).handle(
      {
        id: 'r1',
        name: 'lsp_find_references',
        arguments: { file: '/p/x.ts', line: 3, character: 5 },
      },
      CTX,
    );
    assert.strictEqual(out.ok, true);
    assert.strictEqual(String(out.output).split('\n').length, 2);
  });
  test('未命中返回「未找到引用」', async () => {
    const out = await new LspFindReferencesTool(new FakeLsp('empty')).handle(
      {
        id: 'r2',
        name: 'lsp_find_references',
        arguments: { file: '/p/x.ts', line: 1, character: 1 },
      },
      CTX,
    );
    assert.strictEqual(out.output, '未找到引用');
  });
});

describe('LspHoverTool', () => {
  test('命中返回文档文本', async () => {
    const out = await new LspHoverTool(new FakeLsp()).handle(
      { id: 'h1', name: 'lsp_hover', arguments: { file: '/p/x.ts', line: 1, character: 1 } },
      CTX,
    );
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.output, 'doc for symbol');
  });
  test('无文档返回「无悬停文档」', async () => {
    const out = await new LspHoverTool(new FakeLsp('empty')).handle(
      { id: 'h2', name: 'lsp_hover', arguments: { file: '/p/x.ts', line: 1, character: 1 } },
      CTX,
    );
    assert.strictEqual(out.output, '无悬停文档');
  });
});

describe('LspStatusTool', () => {
  test('返回后端名', async () => {
    const out = await new LspStatusTool(new FakeLsp()).handle(
      { id: 's1', name: 'lsp_status', arguments: {} },
      CTX,
    );
    assert.strictEqual(out.ok, true);
    assert.match(String(out.output), /fake-lsp/);
  });
});
