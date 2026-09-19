/**
 * LSP 全局符号搜索（`workspace/symbol`）单测。
 *
 * 覆盖两半：
 * ① **归一化**——用真 spawn 的 mock LSP 服务器（`tests/fixtures/mockLspServer.mjs`），
 *    它一次返回两种上游形状（`WorkspaceSymbol` 带 location / 缺 location、
 *    `SymbolInformation` 带 `containerName`），据此钉住「两种形状都要兼容并归一」
 *    与「无位置的结果用查询串占位而不是静默丢弃」；
 * ② **工具层**——kind / file 过滤、排序、空结果文案、异常转 ok:false。
 *
 * 全测试**不依赖任何真实语言服务器**：mock 只实现 LSP 最小子集 + workspace/symbol。
 */
import { strict as assert } from 'node:assert/strict';
import { describe, test } from 'node:test';
import { resolve } from 'node:path';
import { LspProcessAdapter } from '../../src/adapters/lsp/lspProcessAdapter.js';
import { fileToUri } from '../../src/adapters/lsp/lspUri.js';
import { LspSymbolNormalizer } from '../../src/adapters/lsp/lspSymbolNormalizer.js';
import { LspWorkspaceSymbolsTool } from '../../src/adapters/tool/lsp/lspWorkspaceSymbolsTool.js';
import type { LspPort, LspWorkspaceSymbol } from '../../src/ports/tool/lsp.js';
import type { ToolCall, ToolContext } from '../../src/ports/tool/tool.js';
import { WORKSPACE_SYMBOL_PATHS } from '../fixtures/lspWorkspaceSymbolFixture.mjs';

/** mock 服务器（源码级 .mjs，不被 tsc 编译，故相对项目根定位）。 */
const mockServer = resolve(process.cwd(), 'tests/fixtures/mockLspServer.mjs');

/**
 * 指向 mock 服务器的适配器。
 *
 * @returns 进程级适配器实例。
 */
function adapter(): LspProcessAdapter {
  return new LspProcessAdapter({
    serverCommand: process.execPath,
    serverArgs: [mockServer],
    rootUri: fileToUri(process.cwd()),
  });
}

/** 造一个工具调用。 */
function call(args: Readonly<Record<string, unknown>>): ToolCall {
  return { id: 'c1', name: 'x', arguments: args };
}

/** 最小工具上下文。 */
const ctx: ToolContext = { sessionId: 's1', workspaceRoot: process.cwd() };

/** 只实现导航的端口（workspaceSymbols 必须缺席——门禁据此不注册死工具）。 */
const navOnlyPort: LspPort = {
  name: 'nav-only',
  definition: async () => [],
  references: async () => [],
  hover: async () => undefined,
  shutdown: async () => undefined,
};

/** 在导航端口基础上补一个可编程的全局符号实现。 */
function portWith(impl: () => Promise<readonly LspWorkspaceSymbol[]>): LspPort {
  return { ...navOnlyPort, workspaceSymbols: impl };
}

describe('LSP workspace/symbol（进程级 JSON-RPC 归一化）', () => {
  test('两种上游形状归一：WorkspaceSymbol + SymbolInformation + 缺位置占位 + 坐标转 1-based', async () => {
    const lsp = adapter();
    try {
      const symbols = await lsp.workspaceSymbols('Demo');
      assert.deepStrictEqual(
        symbols.map((s) => [s.name, s.kind, s.file, s.range.start.line, s.range.start.character]),
        [
          ['DemoClass', 'class', WORKSPACE_SYMBOL_PATHS.demoFile, 10, 7],
          // LSP 3.17 允许 WorkspaceSymbol 只给 uri、不给区间 ⇒ 按文件起点呈现，而不是丢掉这条。
          ['dirOnly', 'module', WORKSPACE_SYMBOL_PATHS.srcDir, 1, 1],
          ['topLevelFn', 'function', WORKSPACE_SYMBOL_PATHS.demoFile, 21, 10],
          // 这一条上游是扁平式 SymbolInformation（同一字段名，故走同一条归一化路径）。
          ['helper', 'function', WORKSPACE_SYMBOL_PATHS.utilFile, 3, 1],
        ],
      );
      // URI 必须转回普通文件系统路径，而不是 file://
      assert.ok(symbols.every((s) => !s.file.startsWith('file://')));
      // 容器名：非空保留、空白丢弃（不给模型一串空格当信息）
      assert.strictEqual(symbols[0]?.container, 'demo');
      assert.strictEqual(symbols[1]?.container, undefined);
      assert.strictEqual(symbols[2]?.container, undefined, '空白 containerName 必须省略');
      assert.strictEqual(symbols[3]?.container, 'Util');
    } finally {
      await lsp.shutdown();
    }
  });

  test('畸形条目被跳过而不是抛错；无匹配时为空数组', async () => {
    const lsp = adapter();
    try {
      // query 含 junk ⇒ mock 回 null / 数字 / 无名 / 无位置四类畸形条目
      assert.deepStrictEqual(await lsp.workspaceSymbols('junk-query'), []);
      assert.deepStrictEqual(await lsp.workspaceSymbols('no-such-symbol-xyz'), []);
    } finally {
      await lsp.shutdown();
    }
  });

  test('端口把 workspaceSymbols 声明为可选（只实现导航的适配器照样编译/运行）', () => {
    assert.strictEqual(navOnlyPort.workspaceSymbols, undefined);
  });

  test('归一化边界：无 URI 但给了区间 ⇒ 回落占位文件；无 URI 也无区间 ⇒ 跳过', () => {
    // 只给区间、不给 URI（少数服务器会这样回）：位置是真的，文件用占位串如实表示。
    assert.deepStrictEqual(
      LspSymbolNormalizer.normalizeWorkspace(
        [
          {
            name: 'orphan',
            kind: 12,
            range: { start: { line: 3, character: 1 }, end: { line: 3, character: 2 } },
          },
        ],
        '(工作区查询: q)',
      ),
      [
        {
          name: 'orphan',
          kind: 'function',
          file: '(工作区查询: q)',
          range: { start: { line: 4, character: 2 }, end: { line: 4, character: 3 } },
        },
      ],
    );
    // 既无 URI 又无区间 ⇒ 无文件也无位置，报出去只会是假信息，故跳过。
    assert.deepStrictEqual(
      LspSymbolNormalizer.normalizeWorkspace([{ name: 'nothing', kind: 12 }], '(q)'),
      [],
    );
    // 非 file:// 的虚拟文档且无区间 ⇒ 转不成文件路径，同样跳过。
    assert.deepStrictEqual(
      LspSymbolNormalizer.normalizeWorkspace(
        [{ name: 'virtual', kind: 12, location: { uri: 'untitled:Untitled-1' } }],
        '(q)',
      ),
      [],
    );
  });

  test('畸形 file:// URI：降级返回原串，绝不抛错（Windows 上缺盘符的 URI 会解析失败）', () => {
    // 无区间 ⇒ 文件串原样呈现（URI 至少说明「在哪个文件」），位置用文件起点。
    assert.deepStrictEqual(
      LspSymbolNormalizer.normalizeWorkspace(
        [{ name: 'broken', kind: 12, location: { uri: 'file:///repo/a.ts' } }],
        '(q)',
      ),
      [
        {
          name: 'broken',
          kind: 'function',
          file: 'file:///repo/a.ts',
          range: { start: { line: 1, character: 1 }, end: { line: 1, character: 1 } },
        },
      ],
    );
    // 有区间 ⇒ 位置是真的，照常归一。
    const withRange = LspSymbolNormalizer.normalizeWorkspace(
      [
        {
          name: 'broken',
          kind: 12,
          location: {
            uri: 'file:///repo/a.ts',
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
          },
        },
      ],
      '(q)',
    );
    assert.strictEqual(withRange.length, 1);
    assert.strictEqual(withRange[0]?.range.start.line, 1);
  });

  test('幂等与上限：非数组输入不抛错（null/undefined/单对象）', () => {
    assert.deepStrictEqual(LspSymbolNormalizer.normalizeWorkspace(null, '(q)'), []);
    assert.deepStrictEqual(LspSymbolNormalizer.normalizeWorkspace(undefined, '(q)'), []);
    // 单个对象（非数组）也按「一条结果」处理，而不是当畸形丢掉。
    const single = LspSymbolNormalizer.normalizeWorkspace(
      {
        name: 'one',
        kind: 5,
        location: {
          uri: 'file:///tmp/one.ts',
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
        },
      },
      '(q)',
    );
    assert.strictEqual(single.length, 1);
    assert.strictEqual(single[0]?.name, 'one');
  });
});

describe('lsp_workspace_symbols 工具', () => {
  test('渲染：按 文件→行→列 排序；kind 过滤；file 按路径边界过滤', async () => {
    const tool = new LspWorkspaceSymbolsTool(
      portWith(async () => [
        {
          name: 'classFn',
          kind: 'method',
          file: '/repo/src/a.ts',
          range: { start: { line: 9, character: 3 }, end: { line: 9, character: 5 } },
          container: 'A',
        },
        {
          name: 'EarlyClass',
          kind: 'class',
          file: '/repo/src/a.ts',
          range: { start: { line: 2, character: 7 }, end: { line: 2, character: 9 } },
        },
        {
          name: 'helper',
          kind: 'function',
          file: '/repo/src/b.ts',
          range: { start: { line: 1, character: 1 }, end: { line: 1, character: 3 } },
        },
      ]),
    );

    const all = await tool.handle(call({ query: 'x' }), ctx);
    assert.strictEqual(all.ok, true);
    assert.strictEqual(
      all.output,
      [
        'class EarlyClass — /repo/src/a.ts:2:7',
        'method classFn [在 A 中] — /repo/src/a.ts:9:3',
        'function helper — /repo/src/b.ts:1:1',
      ].join('\n'),
    );

    const onlyFn = await tool.handle(call({ query: 'x', kind: 'function' }), ctx);
    assert.strictEqual(onlyFn.output, 'function helper — /repo/src/b.ts:1:1');

    // Windows 风格分隔符也要认；且 `src/a.ts` 只命中该文件，不会连 `src/a.tsx` 一起收。
    const onlyA = await tool.handle(call({ query: 'x', file: 'src\\a.ts' }), ctx);
    assert.strictEqual(
      onlyA.output,
      [
        'class EarlyClass — /repo/src/a.ts:2:7',
        'method classFn [在 A 中] — /repo/src/a.ts:9:3',
      ].join('\n'),
    );

    // 目录写法（相对）也要命中其下的文件——朴素前缀匹配会在这里漏。
    const underDir = await tool.handle(call({ query: 'x', file: 'src' }), ctx);
    assert.strictEqual(
      underDir.output,
      [
        'class EarlyClass — /repo/src/a.ts:2:7',
        'method classFn [在 A 中] — /repo/src/a.ts:9:3',
      ].join('\n'),
    );
    // 文件过滤串按**整段**比对：`a.ts` 不该命中 `a.tsx` 或 `deep/a.ts`。
    const exactName = await tool.handle(call({ query: 'x', file: 'a.ts' }), ctx);
    assert.strictEqual(
      exactName.output,
      [
        'class EarlyClass — /repo/src/a.ts:2:7',
        'method classFn [在 A 中] — /repo/src/a.ts:9:3',
      ].join('\n'),
    );
  });

  test('路径过滤按段边界：`src` 不匹配 `srcfoo/...`', async () => {
    const tool = new LspWorkspaceSymbolsTool(
      portWith(async () => [
        {
          name: 'inSrc',
          kind: 'function',
          file: '/repo/src/a.ts',
          range: { start: { line: 1, character: 1 }, end: { line: 1, character: 2 } },
        },
        {
          name: 'inSrcfoo',
          kind: 'function',
          file: '/repo/srcfoo/a.ts',
          range: { start: { line: 1, character: 1 }, end: { line: 1, character: 2 } },
        },
      ]),
    );
    const result = await tool.handle(call({ query: 'a', file: 'src' }), ctx);
    assert.strictEqual(result.output, 'function inSrc — /repo/src/a.ts:1:1');
  });

  test('kind 家族：未知种类回落 `symbol#<n>`，裸 `symbol` 前缀可一次收全', async () => {
    const tool = new LspWorkspaceSymbolsTool(
      portWith(async () => [
        {
          name: 'mystery',
          kind: 'symbol#99',
          file: '/repo/a.ts',
          range: { start: { line: 1, character: 1 }, end: { line: 1, character: 2 } },
        },
        {
          name: 'known',
          kind: 'function',
          file: '/repo/a.ts',
          range: { start: { line: 2, character: 1 }, end: { line: 2, character: 2 } },
        },
      ]),
    );
    const family = await tool.handle(call({ query: 'm', kind: 'symbol' }), ctx);
    assert.strictEqual(family.output, 'symbol#99 mystery — /repo/a.ts:1:1');
    const exact = await tool.handle(call({ query: 'm', kind: 'symbol#99' }), ctx);
    assert.strictEqual(exact.output, 'symbol#99 mystery — /repo/a.ts:1:1');
    const known = await tool.handle(call({ query: 'k', kind: 'function' }), ctx);
    assert.strictEqual(known.output, 'function known — /repo/a.ts:2:1');
  });

  test('空结果回显过滤条件；参数非法与端口异常都走可读文案', async () => {
    const empty = new LspWorkspaceSymbolsTool(portWith(async () => []));
    const none = await empty.handle(call({ query: 'zzz' }), ctx);
    assert.strictEqual(none.ok, true);
    assert.strictEqual(none.output, '未找到符号: zzz');
    const filtered = await empty.handle(call({ query: 'zzz', file: '/repo/src' }), ctx);
    assert.strictEqual(filtered.output, '未找到符号: zzz（已按路径过滤: /repo/src）');

    const noQuery = await empty.handle(call({}), ctx);
    assert.strictEqual(noQuery.ok, false);
    assert.match(noQuery.error ?? '', /缺少查询参数: query/);

    const badKind = await empty.handle(call({ query: 'x', kind: 'not a kind' }), ctx);
    assert.strictEqual(badKind.ok, false);
    assert.match(badKind.error ?? '', /kind 过滤取值非法/);

    const boom = new LspWorkspaceSymbolsTool(
      portWith(async () => {
        throw new Error('server down');
      }),
    );
    const failed = await boom.handle(call({ query: 'x' }), ctx);
    assert.strictEqual(failed.ok, false);
    assert.match(failed.error ?? '', /LSP 全局符号查询失败: server down/);

    // 端口没实现该能力（undefined）时不抛错，按「无结果」如实回报。
    const unavailable = await new LspWorkspaceSymbolsTool(navOnlyPort).handle(
      call({ query: 'x' }),
      ctx,
    );
    assert.strictEqual(unavailable.ok, true);
    assert.strictEqual(unavailable.output, '未找到符号: x');
  });
});
