/**
 * 报告构建 / 三种渲染 / 回读复核 的判据。
 *
 * 关键断言：
 * - 摘要里的数字能从记录重算（链覆盖它们）；
 * - HTML 载荷内嵌 + 回读后链仍完整；
 * - 正文里的 `</script>` 不得提前闭合载荷标签（注入面）；
 * - 改动载荷里的任意一条 ⇒ 复核必须红（正对照，防"恒绿"）。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditFormatting } from '../../src/apps/audit/auditFormatting.ts';
import { AuditHtmlRenderer } from '../../src/apps/audit/auditHtmlRenderer.ts';
import { AuditMarkdownRenderer } from '../../src/apps/audit/auditMarkdownRenderer.ts';
import { AuditReportBuilder } from '../../src/apps/audit/auditReportBuilder.ts';
import { AuditReportStore } from '../../src/apps/audit/auditReportStore.ts';
import { AuditReportVerifier } from '../../src/apps/audit/auditReportVerifier.ts';
import { AuditSourceLoader } from '../../src/apps/audit/auditSourceLoader.ts';
import type { AuditLoadedSource, AuditReport } from '../../src/apps/audit/auditTypes.ts';

const FIXTURES = join(process.cwd(), 'tests', 'fixtures', 'audit');

/** 用夹具构建一份可复现的报告。 */
function reportOf(fixture = 'omni.jsonl'): AuditReport {
  const loaded = new AuditSourceLoader().load(join(FIXTURES, fixture));
  return new AuditReportBuilder().build(loaded, {
    generatorVersion: 'test',
    generatedAt: '2026-11-02T00:00:00.000Z',
    title: '测试报告',
  });
}

test('① 摘要与文件表可从记录重算', () => {
  const report = reportOf();
  assert.strictEqual(report.summary.total, 8);
  assert.strictEqual(report.summary.toolCalls, 1);
  assert.strictEqual(report.summary.toolFailures, 1);
  assert.strictEqual(report.summary.approvals, 0);
  assert.strictEqual(report.summary.filesChanged, 1);
  assert.strictEqual(report.summary.durationMs, 7000);
  assert.deepStrictEqual(report.files, [{ path: 'src/a.ts', added: 1, removed: 1, touches: 2 }]);
  assert.deepStrictEqual(report.tokens, { prompt: 100, completion: 20, cached: 50, total: 120 });
  assert.strictEqual(report.integrity.count, 8);
  assert.strictEqual(report.integrity.head.length, 64);
  assert.strictEqual(new AuditReportVerifier().verify(report).ok, true);
  // 结果回填：call_1 的 tool_result 是失败 ⇒ 工具调用记录也应是 error（时间线不显示 PENDING）。
  assert.strictEqual(report.records[4]?.record.status, 'error');
});

test('② HTML：载荷可回读、链完整、页面自带复核按钮 + 文件级自指纹', () => {
  const report = reportOf();
  const store = new AuditReportStore();
  const html = store.render(report, 'html');
  assert.match(html, /id="oh-audit-payload"/);
  assert.match(html, /id="oh-verify"/);
  assert.match(html, /测试报告/);
  const parsed = store.parse(html, 'x.html');
  assert.strictEqual(parsed.format, 'html');
  const { artifact, ...payload } = parsed.report;
  assert.deepStrictEqual(payload, report);
  assert.match(artifact?.sha256 ?? '', /^[0-9a-f]{64}$/);
  assert.strictEqual(new AuditReportVerifier().verify(parsed.report).ok, true);
  assert.strictEqual(new AuditReportVerifier().verifyFile(parsed.report, html, 'html').ok, true);
});

test('③ Markdown：载荷标记 + 围栏 JSON 可回读；JSON 直读', () => {
  const report = reportOf();
  const store = new AuditReportStore();
  const markdown = store.render(report, 'md');
  assert.ok(markdown.includes(AuditMarkdownRenderer.PAYLOAD_MARKER));
  const fromMd = store.parse(markdown, 'x.md');
  assert.strictEqual(fromMd.format, 'md');
  const { artifact, ...mdPayload } = fromMd.report;
  assert.deepStrictEqual(mdPayload, report);
  assert.match(artifact?.sha256 ?? '', /^[0-9a-f]{64}$/);
  assert.strictEqual(new AuditReportVerifier().verifyFile(fromMd.report, markdown, 'md').ok, true);
  const fromJson = store.parse(store.render(report, 'json'), 'x.json');
  assert.strictEqual(fromJson.format, 'json');
  assert.deepStrictEqual(fromJson.report, report);
});

test('④ 载荷被改动 ⇒ 复核失败并定位（正对照）', () => {
  const report = reportOf();
  const tampered: AuditReport = {
    ...report,
    records: report.records.map((item, index) =>
      index === 2 ? { ...item, record: { ...item.record, text: '被改过的内容' } } : item,
    ),
  };
  const store = new AuditReportStore();
  const parsed = store.parse(JSON.stringify(tampered), 'tampered.json');
  const result = new AuditReportVerifier().verify(parsed.report);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.brokenAt, 2);
  assert.strictEqual(result.reason, 'hash');
});

test('⑤ 正文里的 </script> 不得提前闭合载荷 / 页面（转义必须落地）', () => {
  const loaded: AuditLoadedSource = {
    path: '/x/session.jsonl',
    sha256: '0'.repeat(64),
    result: {
      format: 'omni',
      sessionId: 'evil',
      workspace: null,
      model: null,
      startedAt: null,
      endedAt: null,
      records: [
        {
          ts: null,
          kind: 'user',
          title: '标题</script><script>alert(1)</script>',
          text: '</script><img src=x onerror=alert(2)>',
        },
      ],
      tokens: null,
      unrecognized: 0,
    },
  };
  const report = new AuditReportBuilder().build(loaded, { generatorVersion: 'test' });
  const html = new AuditHtmlRenderer().render(report);
  assert.strictEqual(html.includes('<img src=x onerror=alert(2)>'), false);
  assert.strictEqual(html.includes('标题</script><script>alert(1)'), false);
  assert.ok(html.includes('\\u003c/script\\u003e'));
  const parsed = new AuditReportStore().parse(html, 'evil.html');
  assert.strictEqual(
    parsed.report.records[0]?.record.text,
    '</script><img src=x onerror=alert(2)>',
  );
});

test('⑥ 落盘 / 回读三种格式（临时目录）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omni-audit-'));
  const store = new AuditReportStore();
  const report = reportOf();
  for (const format of ['html', 'md', 'json'] as const) {
    const path = join(dir, `report.${format}`);
    store.write(report, format, path);
    const back = store.read(path);
    assert.strictEqual(back.format, format);
    assert.strictEqual(
      new AuditReportVerifier().verifyFile(back.report, back.text, back.format).ok,
      true,
    );
  }
  assert.match(readFileSync(join(dir, 'report.html'), 'utf8'), /测试报告/);
});

test('⑥b 只改展示层（不动载荷）：文件级自指纹必须判红；JSON 无展示层可改', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omni-audit-'));
  const store = new AuditReportStore();
  const report = reportOf();
  const htmlPath = join(dir, 'display.html');
  store.write(report, 'html', htmlPath);
  const html = readFileSync(htmlPath, 'utf8');
  const tampered = html.replace('测试报告', '伪造的结论');
  assert.notStrictEqual(tampered, html);
  const parsed = store.parse(tampered, 'display.html');
  assert.strictEqual(new AuditReportVerifier().verify(parsed.report).ok, true, '载荷链本身没动');
  const result = new AuditReportVerifier().verifyFile(parsed.report, tampered, 'html');
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'artifact');

  // 去掉自指纹字段也必须判红（否则"删字段 + 改展示"就能绕过）。
  const noArtifact = tampered.replace(/,"artifact":\{"sha256":"[0-9a-f]{64}"\}/, '');
  const parsedNoArtifact = store.parse(noArtifact, 'display.html');
  assert.strictEqual(
    new AuditReportVerifier().verifyFile(parsedNoArtifact.report, noArtifact, 'html').reason,
    'artifact-missing',
  );
});

test('⑦ 找不到载荷 / 坏 JSON 时报错（不返回"空报告"）', () => {
  const store = new AuditReportStore();
  assert.throws(() => store.parse('hello', 'x.html'), /找不到审计载荷/);
  assert.throws(() => store.parse('{"records": []}', 'x.json'), /缺少 records/);
  assert.throws(() => store.parse('{"records": [', 'x.json'), /不是合法 JSON/);
});

test('⑧ 格式化：时长 / 千分位 / 单行 / 载荷转义', () => {
  assert.strictEqual(AuditFormatting.duration(null), '—');
  assert.strictEqual(AuditFormatting.duration(999), '999 ms');
  assert.strictEqual(AuditFormatting.duration(63_000), '1 分 3 秒');
  assert.strictEqual(AuditFormatting.duration(3_723_000), '1 时 2 分');
  assert.strictEqual(AuditFormatting.number(1234), '1,234');
  assert.strictEqual(AuditFormatting.oneLine('a\n\nb', 10), 'a b');
  assert.strictEqual(AuditFormatting.markdownCell('a|b'), 'a\\|b');
  assert.strictEqual(AuditFormatting.embedJson('a&b<c>\u2028'), 'a\\u0026b\\u003cc\\u003e\\u2028');
});

test('⑨ Markdown 围栏必须避开正文里的反引号（否则载荷被提前闭合）', () => {
  const loaded: AuditLoadedSource = {
    path: '/x/fence.jsonl',
    sha256: '0'.repeat(64),
    result: {
      format: 'omni',
      sessionId: 'fence',
      workspace: null,
      model: null,
      startedAt: null,
      endedAt: null,
      records: [{ ts: null, kind: 'assistant', title: '代码', text: '```json\n{"x":1}\n```' }],
      tokens: null,
      unrecognized: 0,
    },
  };
  const report = new AuditReportBuilder().build(loaded, { generatorVersion: 'test' });
  const store = new AuditReportStore();
  const parsed = store.parse(new AuditMarkdownRenderer().render(report), 'fence.md');
  assert.strictEqual(parsed.format, 'md');
  assert.deepStrictEqual(parsed.report, report);
  assert.strictEqual(new AuditReportVerifier().verify(parsed.report).ok, true);
});
