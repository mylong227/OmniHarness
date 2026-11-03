/**
 * `audit report` / `audit verify` 用例编排与 CLI 接线判据。
 *
 * 覆盖：单文件 / 目录批量、三种输出格式、错路径、链完整性、篡改后复核失败、
 * CLI 的 `report` / 简写 / `verify` / 用法错误四种入口。
 */
import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditCommand } from '../../src/apps/cli/auditCommand.ts';
import { AuditTool } from '../../src/apps/audit/auditTool.ts';

const FIXTURES = join(process.cwd(), 'tests', 'fixtures', 'audit');

/** 静音 stdout/stderr（工具与 CLI 都会打印）。 */
function silence<T>(run: () => T): { value: T; out: string } {
  let out = '';
  const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown): boolean => {
    out += String(chunk);
    return true;
  });
  const err = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown): boolean => {
    out += String(chunk);
    return true;
  });
  try {
    return { value: run(), out };
  } finally {
    write.mockRestore();
    err.mockRestore();
  }
}

test('① 单文件出证：写出 HTML、打印摘要、复核通过', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omni-audit-'));
  const target = join(dir, 'one.html');
  const tool = new AuditTool();
  const result = silence(() =>
    tool.report({
      inputs: [join(FIXTURES, 'omni.jsonl')],
      format: 'html',
      out: target,
      title: '一次任务',
    }),
  );
  assert.strictEqual(result.value, 0);
  assert.match(result.out, /链头/);
  assert.ok(existsSync(target));
  assert.match(readFileSync(target, 'utf8'), /一次任务/);
  assert.strictEqual(silence(() => tool.verify([target])).value, 0);
});

test('② 目录批量：每个会话一份报告，全部可复核', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omni-audit-'));
  const outDir = join(dir, 'reports');
  const tool = new AuditTool();
  const result = silence(() =>
    tool.report({ inputs: [FIXTURES], format: 'html', out: outDir, title: null }),
  );
  assert.strictEqual(result.value, 0);
  const names = ['omni-1', 'claude-1', 'codex-1', 'acp-1'].map((id) =>
    join(outDir, `${id}.audit.html`),
  );
  for (const name of names) {
    assert.ok(existsSync(name), `缺少报告 ${name}`);
  }
  assert.strictEqual(silence(() => tool.verify(names)).value, 0);
  // 目录形态：一次复核整个输出目录（报告扩展名 .html）。
  assert.strictEqual(silence(() => tool.verify([outDir])).value, 0);
});

test('②b 输出路径判定：无扩展名视为目录；多文件给单份报告路径必须拒绝', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omni-audit-'));
  const tool = new AuditTool();
  const outDir = join(dir, 'reports');
  assert.strictEqual(
    silence(() =>
      tool.report({
        inputs: [join(FIXTURES, 'omni.jsonl')],
        format: 'html',
        out: outDir,
        title: null,
      }),
    ).value,
    0,
  );
  assert.ok(existsSync(join(outDir, 'omni-1.audit.html')));
  assert.throws(
    () =>
      silence(() =>
        tool.report({
          inputs: [FIXTURES],
          format: 'html',
          out: join(dir, 'single.html'),
          title: null,
        }),
      ),
    /--out 必须是目录/,
  );
});

test('③ 篡改报告后复核必须失败（退出码 1）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omni-audit-'));
  const target = join(dir, 'one.json');
  const tool = new AuditTool();
  silence(() =>
    tool.report({
      inputs: [join(FIXTURES, 'omni.jsonl')],
      format: 'json',
      out: target,
      title: null,
    }),
  );
  const text = readFileSync(target, 'utf8');
  writeFileSync(target, text.replace('把 a.ts 的返回值改成 42', '把 a.ts 的返回值改成 43'));
  const result = silence(() => tool.verify([target]));
  assert.strictEqual(result.value, 1);
  assert.match(result.out, /✗/);
});

test('③b 只改 HTML 展示层（不动载荷）也必须失败（文件级自指纹）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omni-audit-'));
  const target = join(dir, 'display.html');
  const tool = new AuditTool();
  silence(() =>
    tool.report({
      inputs: [join(FIXTURES, 'omni.jsonl')],
      format: 'html',
      out: target,
      title: '原始标题',
    }),
  );
  const html = readFileSync(target, 'utf8');
  writeFileSync(target, html.replace('原始标题', '伪造标题'));
  const result = silence(() => tool.verify([target]));
  assert.strictEqual(result.value, 1);
  assert.match(result.out, /artifact/);
});

test('④ 输入路径不存在 ⇒ 抛出可读错误', () => {
  const tool = new AuditTool();
  assert.throws(
    () =>
      silence(() =>
        tool.report({
          inputs: [join(FIXTURES, 'nope.jsonl')],
          format: 'html',
          out: null,
          title: null,
        }),
      ),
    /路径不存在/,
  );
});

test('⑤ CLI：report 子命令 + 简写 + verify + 用法错误', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omni-audit-'));
  const target = join(dir, 'cli.md');
  const command = new AuditCommand();

  const reported = await silenceAsync(() =>
    command.run([
      'report',
      join(FIXTURES, 'claude-code.jsonl'),
      '--out',
      target,
      '--title',
      'CLI 报告',
    ]),
  );
  assert.strictEqual(reported.value, 0);
  assert.ok(existsSync(target));
  assert.match(readFileSync(target, 'utf8'), /CLI 报告/);

  const shorthand = await silenceAsync(() =>
    command.run([
      join(FIXTURES, 'codex.jsonl'),
      '--format',
      'json',
      '--out',
      join(dir, 'short.json'),
    ]),
  );
  assert.strictEqual(shorthand.value, 0);
  assert.ok(existsSync(join(dir, 'short.json')));

  const verified = await silenceAsync(() => command.run(['verify', target, '--json']));
  assert.strictEqual(verified.value, 0);
  assert.match(verified.out, /"ok": true/);

  assert.strictEqual((await silenceAsync(() => command.run([]))).value, 2);
  assert.strictEqual((await silenceAsync(() => command.run(['report']))).value, 2);
  assert.strictEqual(
    (await silenceAsync(() => command.run(['report', 'x', '--format', 'pdf']))).value,
    2,
  );
  assert.strictEqual(
    (await silenceAsync(() => command.run(['report', 'x', '--source-format', 'nope']))).value,
    2,
  );
  assert.strictEqual((await silenceAsync(() => command.run(['verify']))).value, 2);
  assert.strictEqual((await silenceAsync(() => command.run(['report', 'x', '--bogus']))).value, 2);
});

/** 异步版静音（CLI 的 run 是 async）。 */
async function silenceAsync<T>(run: () => Promise<T>): Promise<{ value: T; out: string }> {
  let out = '';
  const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown): boolean => {
    out += String(chunk);
    return true;
  });
  const err = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown): boolean => {
    out += String(chunk);
    return true;
  });
  try {
    return { value: await run(), out };
  } finally {
    write.mockRestore();
    err.mockRestore();
  }
}

const DRIFT = join(FIXTURES, 'drift-mixed.jsonl');

test('⑥ strict：漂移夹具 ⇒ 1；正常夹具 ⇒ 0；报告仍生成且「未识别 3」可见（CLI 同口径）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omni-audit-'));
  const tool = new AuditTool();
  // 非 strict：exit 0，但未识别数在 stdout 与 JSON 载荷里都可见。
  const loose = silence(() =>
    tool.report({
      inputs: [DRIFT],
      format: 'json',
      out: join(dir, 'loose.json'),
      title: null,
    }),
  );
  assert.strictEqual(loose.value, 0);
  assert.match(loose.out, /未识别 3/);
  assert.match(readFileSync(join(dir, 'loose.json'), 'utf8'), /"unrecognized": 3/);
  // strict：exit 1，报告照样落盘（先留证据再报失败）。
  const strict = silence(() =>
    tool.report({
      inputs: [DRIFT],
      format: 'html',
      out: join(dir, 'strict'),
      title: null,
      strict: true,
    }),
  );
  assert.strictEqual(strict.value, 1);
  assert.match(strict.out, /--strict 判为失败/);
  assert.ok(existsSync(join(dir, 'strict', 'drift-1.audit.html')));
  // 正常夹具 + strict：无未识别 ⇒ 0。
  const clean = silence(() =>
    tool.report({
      inputs: [join(FIXTURES, 'omni.jsonl')],
      format: 'json',
      out: join(dir, 'clean.json'),
      title: null,
      strict: true,
    }),
  );
  assert.strictEqual(clean.value, 0);
  // CLI 接线：--strict 旗标走 reader.has ⇒ 同一退出码。
  const cli = new AuditCommand();
  const command = await silenceAsync(() =>
    cli.run(['report', DRIFT, '--out', join(dir, 'cli'), '--strict']),
  );
  assert.strictEqual(command.value, 1);
});

test('⑦ 覆盖率自洽：改 coverage.recognized ⇒ verify 判 coverage（退出码 1）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omni-audit-'));
  const target = join(dir, 'one.json');
  silence(() =>
    new AuditTool().report({
      inputs: [join(FIXTURES, 'omni.jsonl')],
      format: 'json',
      out: target,
      title: null,
    }),
  );
  const mutated = JSON.parse(readFileSync(target, 'utf8')) as {
    coverage: { recognized: number; unrecognized: number };
  };
  mutated.coverage.recognized += 1;
  writeFileSync(target, `${JSON.stringify(mutated, null, 2)}\n`);
  const result = silence(() => new AuditTool().verify([target]));
  assert.strictEqual(result.value, 1);
  assert.match(result.out, /coverage/);
});

test('⑧ 摘要自洽：改 summary.total ⇒ verify 判 summary（退出码 1）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omni-audit-'));
  const target = join(dir, 'one.json');
  silence(() =>
    new AuditTool().report({
      inputs: [join(FIXTURES, 'omni.jsonl')],
      format: 'json',
      out: target,
      title: null,
    }),
  );
  const mutated = JSON.parse(readFileSync(target, 'utf8')) as { summary: { total: number } };
  mutated.summary.total += 1;
  writeFileSync(target, `${JSON.stringify(mutated, null, 2)}\n`);
  const result = silence(() => new AuditTool().verify([target]));
  assert.strictEqual(result.value, 1);
  assert.match(result.out, /summary/);
});
