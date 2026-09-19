/**
 * 写后自动诊断回灌单测（P1-⑦ 后半）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PostWriteDiagnosticsPort } from '../../src/adapters/tool/verify/postWriteDiagnosticsPort.js';
import { MutationTargets } from '../../src/adapters/tool/verify/mutationTargets.js';
import { SelfVerifyPolicy } from '../../src/adapters/tool/verify/selfVerifyPolicy.js';
import type { LspDiagnostic, LspDiagnosticReport } from '../../src/ports/tool/lsp.js';
import type { ToolCall, ToolContext, ToolPort, ToolResult } from '../../src/ports/tool/tool.js';

/** 内层端口替身（固定返回给定结果）。 */
const innerPort = (result: ToolResult): ToolPort => ({
  name: 'stub',
  list: () => [
    { name: 'write_file', description: 'w', parameters: { type: 'object', properties: {} } },
  ],
  execute: async (): Promise<ToolResult> => result,
});

/** 造一条 error 级诊断。 */
const errorDiagnostic = (file: string, line: number, message: string): LspDiagnostic => ({
  file,
  range: { start: { line, character: 1 }, end: { line, character: 5 } },
  severity: 'error',
  message,
  code: 'TS2322',
});

/** 测试用工具上下文。 */
const ctx: ToolContext = { sessionId: 's1', workspaceRoot: '/repo' };

/**
 * 组装被测装饰器：触发器与生产装配逐字一致（MutationTargets + 源码扩展名）。
 *
 * @param diagnostics 诊断取值替身。
 * @returns 装饰后的端口与「诊断被调用次数」计数器。
 */
const build = (
  diagnostics: (file: string) => Promise<LspDiagnosticReport>,
): { readonly port: ToolPort; readonly calls: { count: number } } => {
  const calls = { count: 0 };
  const port = new PostWriteDiagnosticsPort(
    innerPort({ callId: 'c1', ok: true, output: '已写入 a.ts' }),
    {
      workspaceRoot: '/repo',
      diagnostics: async (file) => {
        calls.count += 1;
        return diagnostics(file);
      },
      shouldCheck: (toolName, args) =>
        MutationTargets.of(toolName, args).some((path) =>
          SelfVerifyPolicy.isVerifiableTarget(path),
        ),
    },
  );
  return { port, calls };
};

/** 源码写入调用。 */
const call: ToolCall = {
  id: 'c1',
  name: 'write_file',
  arguments: { path: 'src/a.ts', content: 'const a = 1;' },
};

test('有 error 级诊断 → 追加回灌段', async () => {
  const { port, calls } = build(async () => ({
    file: '/repo/src/a.ts',
    status: 'fresh',
    diagnostics: [errorDiagnostic('/repo/src/a.ts', 12, '类型不匹配')],
  }));
  const out = await port.execute(call, ctx);
  assert.strictEqual(out.ok, true);
  assert.ok(out.output?.includes('[写后诊断]'));
  assert.ok(out.output?.includes('类型不匹配'));
  assert.ok(out.output?.includes('已写入 a.ts'), '原输出必须保留');
  assert.strictEqual(calls.count, 1);
});

test('无诊断 / 仅 warning / stale → 一律不出声（不制造噪点）', async () => {
  const empty = build(async () => ({ file: '/repo/src/a.ts', status: 'fresh', diagnostics: [] }));
  assert.strictEqual((await empty.port.execute(call, ctx)).output, '已写入 a.ts');

  const warning = build(async () => ({
    file: '/repo/src/a.ts',
    status: 'fresh',
    diagnostics: [{ ...errorDiagnostic('/repo/src/a.ts', 3, '建议'), severity: 'warning' }],
  }));
  assert.strictEqual((await warning.port.execute(call, ctx)).output, '已写入 a.ts');

  const stale = build(async () => ({
    file: '/repo/src/a.ts',
    status: 'stale',
    diagnostics: [errorDiagnostic('/repo/src/a.ts', 3, '可能是旧错误')],
  }));
  assert.strictEqual((await stale.port.execute(call, ctx)).output, '已写入 a.ts');
});

test('非源码目标 / 结果失败 → 完全不取诊断', async () => {
  const mdCall: ToolCall = {
    id: 'c2',
    name: 'write_file',
    arguments: { path: 'docs/x.md', content: '# 标题' },
  };
  const document = build(async () => ({ file: '', status: 'fresh', diagnostics: [] }));
  await document.port.execute(mdCall, ctx);
  assert.strictEqual(document.calls.count, 0, '非源码扩展名不应触发');

  const failed = new PostWriteDiagnosticsPort(
    innerPort({ callId: 'c1', ok: false, error: 'boom' }),
    {
      workspaceRoot: '/repo',
      diagnostics: async (): Promise<LspDiagnosticReport> => {
        throw new Error('不应被调用');
      },
      shouldCheck: () => true,
    },
  );
  const result = await failed.execute(call, ctx);
  assert.strictEqual(result.ok, false);
  assert.ok(result.output === undefined);
});

test('诊断抛错 → fail-open（ok 与输出不变）', async () => {
  const { port } = build(async () => {
    throw new Error('LSP 崩了');
  });
  const out = await port.execute(call, ctx);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.output, '已写入 a.ts');
});

test('apply_patch 省略 path 时也能解析到目标（与自验证同一判据）', async () => {
  const patchCall: ToolCall = {
    id: 'c3',
    name: 'apply_patch',
    arguments: {
      patch: ['--- a/src/b.ts', '+++ b/src/b.ts', '@@ -1,1 +1,1 @@', '-x', '+y'].join('\n'),
    },
  };
  let seen = '';
  const port = new PostWriteDiagnosticsPort(innerPort({ callId: 'c3', ok: true, output: 'ok' }), {
    workspaceRoot: '/repo',
    diagnostics: async (file) => {
      seen = file;
      return {
        file,
        status: 'fresh',
        diagnostics: [errorDiagnostic(file, 1, '补丁引入了错误')],
      };
    },
    shouldCheck: (toolName, args) =>
      MutationTargets.of(toolName, args).some((path) => SelfVerifyPolicy.isVerifiableTarget(path)),
  });
  const out = await port.execute(patchCall, ctx);
  assert.ok(seen.replace(/\\/g, '/').endsWith('src/b.ts'), `应解析到补丁头目标，实际 ${seen}`);
  assert.ok(out.output?.includes('[写后诊断]'));
});

test('ToolPort 透传：name / list / listDirect / unregister', () => {
  const { port } = build(async () => ({ file: '', status: 'fresh', diagnostics: [] }));
  assert.strictEqual(port.name, 'stub');
  assert.strictEqual(port.list().length, 1);
  assert.strictEqual(port.listDirect?.().length, 1);
  assert.strictEqual(port.unregister?.('write_file'), false);
});
