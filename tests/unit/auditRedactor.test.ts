/**
 * auditRedactor 判据（2026-11-04 P3 T3.1）。
 *
 * 对着 PLAN_2026-11.md 的验收口径逐条钉死：绝对路径保留末两段 + 8 位哈希、同值同标
 * （跨记录交叉比对的前提）、secrets 三规则（前缀 / 赋值 / 熵阈值）、默认 off 原样、
 * hits 与标记数自洽。宏 regret：熵阈值 4.3 的"hex 数学上限 4.0"论证由 ⑥ 钉住——
 * 40 位十六进制（git SHA 级别）不得被误伤。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { AuditRedactor } from '../../src/apps/audit/auditRedactor.ts';
import { AuditSourceLoader } from '../../src/apps/audit/auditSourceLoader.ts';

const FIXTURES = join(process.cwd(), 'tests', 'fixtures', 'audit');
const loader = new AuditSourceLoader();

test('① off 模式：原样返回，hits 0，规则表为空', () => {
  const loaded = loader.load(join(FIXTURES, 'sensitive.jsonl'));
  const outcome = AuditRedactor.redactSource(loaded, 'off');
  assert.strictEqual(outcome.info.mode, 'off');
  assert.deepStrictEqual(outcome.info.rules, []);
  assert.strictEqual(outcome.info.hits, 0);
  assert.strictEqual(JSON.stringify(outcome.source), JSON.stringify(loaded));
});

test('② paths 模式：绝对路径 → 末两段+哈希标记；同值同标（三种书写形态一个标记）；密钥不动', () => {
  const loaded = loader.load(join(FIXTURES, 'sensitive.jsonl'));
  const outcome = AuditRedactor.redactSource(loaded, 'paths');
  assert.deepStrictEqual(outcome.info.rules, [AuditRedactor.RULE_PATHS]);
  const text = JSON.stringify(outcome.source);
  // 原路径全文不得出现——两种转义形态都查（JSON.stringify 里反斜杠翻倍）。
  assert.doesNotMatch(text, /C:\\\\Users\\\\alice\\\\secret-proj/);
  assert.doesNotMatch(text, /C:\/Users\/alice\/secret-proj/);
  // 末两段保留（审阅者知道动的是哪个文件）。
  const marker = /\[REDACTED:paths:src\/deploy\.ts#[0-9a-f]{8}\]/;
  assert.match(text, marker);
  // 同值同标：同一语义路径在 JSON 转义正文 / 规范化文件表 / 工具输出里是**同一个**标记。
  const markers = text.match(new RegExp(marker.source, 'g')) ?? [];
  assert.ok(markers.length >= 3, `路径至少出现三次且同标（实测 ${String(markers.length)} 次）`);
  // secrets 不在 paths 模式的规则里：密钥原样保留。
  assert.match(text, /sk-ant-api03-/);
});

test('③ secrets 模式：前缀 / 赋值（变量名保留）/ 高熵全中；路径不动', () => {
  const loaded = loader.load(join(FIXTURES, 'sensitive.jsonl'));
  const outcome = AuditRedactor.redactSource(loaded, 'secrets');
  assert.deepStrictEqual(outcome.info.rules, [
    AuditRedactor.RULE_ASSIGN,
    AuditRedactor.RULE_PREFIX,
    AuditRedactor.RULE_ENTROPY,
  ]);
  const text = JSON.stringify(outcome.source);
  assert.doesNotMatch(text, /sk-ant-api03-/);
  assert.doesNotMatch(text, /ghp_AbCdEfGhIjKlMnOpQrStUvWxYz1234/); // omniharness:fake-secret
  assert.doesNotMatch(text, /sk-proj-XXXXXXXX/);
  assert.doesNotMatch(text, /Bearer eyJ/);
  // 赋值形态：变量名 + 分隔符保留，值是标记——审阅者知道"这里有个 key"。
  assert.match(text, /OPENAI_API_KEY=\[REDACTED:secrets:#[0-9a-f]{8}\]/);
  // 路径不在 secrets 模式的规则里（workspace 原样；文件表的规范化正斜杠形态也在）。
  assert.match(text, /C:\\\\Users\\\\alice\\\\secret-proj/);
  assert.match(text, /C:\/Users\/alice\/secret-proj\/src\/deploy\.ts/);
});

test('④ all 模式：敏感原文 0 命中（验收口径）', () => {
  const loaded = loader.load(join(FIXTURES, 'sensitive.jsonl'));
  const outcome = AuditRedactor.redactSource(loaded, 'all');
  const text = JSON.stringify(outcome.source);
  for (const original of [
    'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789',
    'sk-proj-XXXXXXXXXXXXXXXXXXXXXXXXXX',
    'ghp_AbCdEfGhIjKlMnOpQrStUvWxYz1234', // omniharness:fake-secret
    'Bearer eyJhbGciOiJIUzI1NiJ9',
    'C:\\Users\\alice\\secret-proj',
  ]) {
    assert.ok(!text.includes(original), `原文不得残留：${original}`);
  }
  assert.ok(outcome.info.hits > 0);
  // hits 自洽：替换次数 = 脱敏载体（records + path/workspace）里的标记数——与 verify 的对账同式。
  assert.strictEqual(
    outcome.info.hits,
    AuditRedactor.countMarkers({
      records: outcome.source.result.records,
      path: outcome.source.path,
      workspace: outcome.source.result.workspace,
    }),
  );
});

test('⑤ 稳定性：同一原值跨两次调用同标（跨记录/跨报告交叉比对的前提）', () => {
  const first = AuditRedactor.redactSource(loader.load(join(FIXTURES, 'sensitive.jsonl')), 'all');
  const second = AuditRedactor.redactSource(loader.load(join(FIXTURES, 'sensitive.jsonl')), 'all');
  assert.strictEqual(first.info.hits, second.info.hits);
  assert.strictEqual(JSON.stringify(first.source), JSON.stringify(second.source));
});

test('⑥ 熵阈值口径：40 位十六进制（git SHA 级）不得误伤；base64url 高熵串必须命中', () => {
  const sha = '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c';
  const kept = AuditRedactor.redactSource(
    {
      path: '/x/s.jsonl',
      sha256: '0'.repeat(64),
      result: {
        format: 'omni',
        sessionId: null,
        workspace: null,
        model: null,
        startedAt: null,
        endedAt: null,
        records: [
          { ts: null, kind: 'system', title: 't', text: `提交 ${sha} 完成` },
          {
            ts: null,
            kind: 'system',
            title: 't2',
            text: 'token=Zx9Qw8Er7Ty5Ui3Op4As6Df2Gh1Jk4Lz0XcVbNm5',
          },
        ],
        tokens: null,
        unrecognized: 0,
      },
    },
    'all',
  );
  assert.match(JSON.stringify(kept.source.result.records), new RegExp(sha));
  assert.doesNotMatch(
    JSON.stringify(kept.source.result.records),
    /Zx9Qw8Er7Ty5Ui3Op4As6Df2Gh1Jk4Lz0XcVbNm5/,
  );
});

test('⑦ 输入自带的字面标记 / 长高熵路径：不被二次改写，hits 仍等于标记数（无嵌套）', () => {
  const longSegment = 'aB3xK9mQ2pL7vR4tY8wZ1cN6bM5sD0fG';
  const literal = '[REDACTED:secrets:#deadbeef]';
  const loaded = {
    path: '/x/s.jsonl',
    sha256: '0'.repeat(64),
    result: {
      format: 'omni' as const,
      sessionId: null,
      workspace: null,
      model: null,
      startedAt: null,
      endedAt: null,
      records: [
        {
          ts: null,
          kind: 'system' as const,
          title: 't',
          text: `路径 C:\\Users\\alice\\proj\\${longSegment}.ts 与 ${literal}`,
        },
      ],
      tokens: null,
      unrecognized: 0,
    },
  };
  const outcome = AuditRedactor.redactSource(loaded, 'all');
  const text = JSON.stringify(outcome.source.result.records);
  // 路径标记的显示段含 37 位高熵串：后置的高熵兜底不得把它二次替换。
  assert.match(text, /\[REDACTED:paths:proj\/ab3xk9m[^#]*#[0-9a-f]{8}\]/);
  assert.ok(text.includes(literal), '输入自带的字面标记保持原样');
  assert.doesNotMatch(text, /\[REDACTED:[^\]]*\[REDACTED:/, '不得产出嵌套标记');
  assert.strictEqual(
    outcome.info.hits,
    AuditRedactor.countMarkers({
      records: outcome.source.result.records,
      path: outcome.source.path,
      workspace: outcome.source.result.workspace,
    }),
  );
});
