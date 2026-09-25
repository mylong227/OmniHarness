import { strict as assert } from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { LspProcessAdapter } from '../../src/adapters/lsp/lspProcessAdapter.js';
import { LspUri } from '../../src/adapters/lsp/lspUri.js';
import { LspDiagnosticsTool } from '../../src/adapters/tool/lsp/lspDiagnosticsTool.js';
import type { LspPort } from '../../src/ports/tool/lsp.js';

// mock 服务器为源码级 .mjs（不被 tsc 编译），相对于项目根定位。
const mockServer = resolve(process.cwd(), 'tests/fixtures/mockLspServer.mjs');
const context = { sessionId: 's1', workspaceRoot: process.cwd() };

/** 起一个跑 mock 服务器的 LSP 进程适配器。 */
const adapter = (): LspProcessAdapter =>
  new LspProcessAdapter({
    serverCommand: process.execPath,
    serverArgs: [mockServer],
    rootUri: LspUri.fileToUri(process.cwd()),
  });

test('lsp_diagnostics：端到端拿到真实推送的诊断，且坐标转回 1-based', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omniharness-lspdiag-'));
  const lsp = adapter();
  try {
    const file = join(dir, 'bad.ts');
    await writeFile(file, 'const x = missingSymbol;\n', 'utf8');
    const result = await new LspDiagnosticsTool(lsp).handle(
      { id: 'c1', name: 'lsp_diagnostics', arguments: { file } },
      context,
    );
    assert.strictEqual(result.ok, true);
    assert.match(result.output ?? '', /共 2 条诊断/);
    // mock 推 0-based line 4 / 1 ⇒ 1-based 5 / 2（行号必须转回编辑器约定）。
    assert.match(result.output ?? '', /error 5:\d+ Cannot find name 'missingSymbol'\. \[2304\]/);
    assert.match(result.output ?? '', /warning 2:\d+ Unused variable\./);
  } finally {
    await lsp.shutdown();
    await rm(dir, { recursive: true, force: true });
  }
});

test('lsp_diagnostics：干净文件（服务器推空数组）报「无诊断」而不是 stale', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omniharness-lspdiag-'));
  const lsp = adapter();
  try {
    const file = join(dir, 'ok.ts');
    await writeFile(file, 'const ok: number = 1; // LSP_OK\n', 'utf8');
    const result = await new LspDiagnosticsTool(lsp).handle(
      { id: 'c1', name: 'lsp_diagnostics', arguments: { file } },
      context,
    );
    assert.strictEqual(result.ok, true);
    assert.match(result.output ?? '', /无诊断/);
  } finally {
    await lsp.shutdown();
    await rm(dir, { recursive: true, force: true });
  }
});

test('lsp_diagnostics：stale 报告必须写明「不代表没有错误」（诚实优先，禁止误导为编译通过）', async () => {
  const stub = {
    name: 'stub-lsp',
    diagnostics: async (file: string) => ({ file, diagnostics: [], status: 'stale' as const }),
  } as unknown as LspPort;
  const result = await new LspDiagnosticsTool(stub).handle(
    { id: 'c1', name: 'lsp_diagnostics', arguments: { file: '/p/x.ts' } },
    context,
  );
  assert.strictEqual(result.ok, true);
  assert.match(result.output ?? '', /未在等待窗口内收到/);
  assert.match(result.output ?? '', /这不代表没有错误/);
});

test('lsp_diagnostics：适配器不支持 diagnostics 时明确失败（不静默装作无错）', async () => {
  const stub = { name: 'stub-lsp' } as unknown as LspPort;
  const result = await new LspDiagnosticsTool(stub).handle(
    { id: 'c1', name: 'lsp_diagnostics', arguments: { file: '/p/x.ts' } },
    context,
  );
  assert.strictEqual(result.ok, false);
  assert.match(result.error ?? '', /不支持诊断/);
});

test('lsp_diagnostics：缺少 file 参数时报错', async () => {
  const stub = { name: 'stub-lsp' } as unknown as LspPort;
  const result = await new LspDiagnosticsTool(stub).handle(
    { id: 'c1', name: 'lsp_diagnostics', arguments: {} },
    context,
  );
  assert.strictEqual(result.ok, false);
  assert.match(result.error ?? '', /缺少文件参数/);
});
