/**
 * 四种会话来源解析器判据（夹具在 `tests/fixtures/audit/`）。
 *
 * 每条断言都对着**具体字段**（而不是"能解析出东西"）：来源格式识别、会话/工作区/模型、
 * 工具调用的文件与结局、token 口径、以及"同一份 rollout 里 event_msg 与 response_item
 * 同时出现时不得重复计一条用户消息"。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditJsonl } from '../../src/apps/audit/auditJsonl.ts';
import { AuditSourceDetector } from '../../src/apps/audit/auditSourceDetector.ts';
import { AuditSourceLoader } from '../../src/apps/audit/auditSourceLoader.ts';
import { OmniSessionParser } from '../../src/apps/audit/omniSessionParser.ts';

const FIXTURES = join(process.cwd(), 'tests', 'fixtures', 'audit');
const loader = new AuditSourceLoader();

test('① OmniHarness 会话：事件类型 / 文件 / 回合 diff / token', () => {
  const loaded = loader.load(join(FIXTURES, 'omni.jsonl'));
  const result = loaded.result;
  assert.strictEqual(result.format, 'omni');
  assert.strictEqual(result.sessionId, 'omni-1');
  assert.strictEqual(result.workspace, '/repo');
  assert.strictEqual(result.model, 'deepseek-v4-flash');
  assert.deepStrictEqual(
    result.records.map((record) => record.kind),
    ['session', 'user', 'other', 'assistant', 'tool_call', 'tool_result', 'turn', 'assistant'],
  );
  const call = result.records[4];
  assert.deepStrictEqual(call?.files, ['src/a.ts']);
  assert.strictEqual(call?.tool, 'write_file');
  assert.strictEqual(result.records[5]?.status, 'error');
  const turn = result.records[6];
  assert.deepStrictEqual(turn?.fileStats, [{ path: 'src/a.ts', added: 1, removed: 1, touches: 1 }]);
  assert.deepStrictEqual(result.tokens, { prompt: 100, completion: 20, cached: 50, total: 120 });
  assert.strictEqual(result.startedAt, '2026-11-02T10:00:00.000Z');
  assert.strictEqual(result.endedAt, '2026-11-02T10:00:07.000Z');
  assert.strictEqual(loaded.sha256.length, 64);
});

test('② Claude Code transcript：正文 / 思考 / tool_use / tool_result / usage', () => {
  const result = loader.load(join(FIXTURES, 'claude-code.jsonl')).result;
  assert.strictEqual(result.format, 'claude-code');
  assert.strictEqual(result.sessionId, 'claude-1');
  assert.strictEqual(result.workspace, '/repo');
  assert.strictEqual(result.model, 'claude-sonnet-4-20250514');
  assert.deepStrictEqual(
    result.records.map((record) => record.kind),
    ['user', 'assistant', 'reasoning', 'tool_call', 'tool_result', 'system', 'system'],
  );
  assert.deepStrictEqual(result.records[3]?.files, ['/repo/src/b.ts']);
  assert.deepStrictEqual(result.records[4]?.files, ['/repo/src/b.ts']);
  assert.strictEqual(result.records[4]?.status, 'ok');
  assert.deepStrictEqual(result.tokens, { prompt: 15, completion: 30, cached: 100, total: 145 });
});

test('③ Codex rollout：response_item 与 event_msg 去重、apply_patch 文件、token_count', () => {
  const result = loader.load(join(FIXTURES, 'codex.jsonl')).result;
  assert.strictEqual(result.format, 'codex');
  assert.strictEqual(result.sessionId, 'codex-1');
  assert.strictEqual(result.workspace, '/work');
  assert.strictEqual(result.model, 'gpt-5-codex');
  const users = result.records.filter((record) => record.kind === 'user');
  const assistants = result.records.filter((record) => record.kind === 'assistant');
  assert.strictEqual(users.length, 1, 'event_msg 的重复用户消息必须被跳过');
  assert.strictEqual(assistants.length, 1, 'event_msg 的重复助手消息必须被跳过');
  const call = result.records.find((record) => record.kind === 'tool_call');
  assert.strictEqual(call?.tool, 'apply_patch');
  assert.deepStrictEqual(call?.files, ['src/c.ts']);
  assert.deepStrictEqual(result.tokens, { prompt: 200, completion: 40, cached: 120, total: 240 });
  assert.ok(result.records.some((record) => record.title === '回合上下文'));
});

test('④ ACP 转录：增量块合并、工具调用、审批一问一答', () => {
  const result = loader.load(join(FIXTURES, 'acp.jsonl')).result;
  assert.strictEqual(result.format, 'acp');
  assert.strictEqual(result.sessionId, 'acp-1');
  assert.strictEqual(result.workspace, '/acp-work');
  const assistant = result.records.find((record) => record.kind === 'assistant');
  assert.strictEqual(assistant?.text, '好的，我来跑。');
  const call = result.records.find((record) => record.kind === 'tool_call');
  assert.strictEqual(call?.callId, 't1');
  assert.deepStrictEqual(call?.files, ['/acp-work/test.ts']);
  const failed = result.records.find((record) => record.kind === 'tool_result');
  assert.strictEqual(failed?.status, 'error');
  const approvals = result.records.filter((record) => record.kind === 'approval');
  assert.strictEqual(approvals.length, 2);
  assert.strictEqual(approvals[1]?.status, 'ok');
  assert.strictEqual(result.tokens, null);
});

test('⑤ 识别器：未知结构返回 null；已知四种命中', () => {
  const detector = new AuditSourceDetector();
  assert.strictEqual(detector.detect('{"hello":"world"}'), null);
  assert.strictEqual(detector.detect('not json at all'), null);
  assert.strictEqual(
    detector.detect('{"jsonrpc":"2.0","method":"session/update","params":{}}'),
    'acp',
  );
  assert.strictEqual(
    detector.detect('{"type":"response_item","payload":{"type":"message"}}'),
    'codex',
  );
  assert.strictEqual(detector.detect('{"type":"user","message":{"role":"user"}}'), 'claude-code');
  assert.strictEqual(detector.detect('{"type":"user","payload":{"content":"hi"}}'), 'omni');
});

test('⑥ 未知格式 fail-closed；--format 覆盖可强制解析', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omni-audit-'));
  const file = join(dir, 'mystery.jsonl');
  writeFileSync(file, '{"hello":"world"}\n');
  assert.throws(() => loader.load(file), /无法识别/);
  const forced = loader.load(file, 'omni');
  assert.strictEqual(forced.result.records.length, 0);
});

test('⑦ 坏行计数但不中止（崩溃时留下的半行仍可出证）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omni-audit-'));
  const file = join(dir, 'partial.jsonl');
  writeFileSync(
    file,
    '{"type":"user","sessionId":"s","timestamp":"2026-11-02T00:00:00.000Z","payload":{"content":"hi"}}\n{"broken":\n',
  );
  const result = loader.load(file, 'omni').result;
  assert.strictEqual(result.records.length, 1);
});

test('⑧ 行数上限 fail-closed（不静默截断）', () => {
  assert.throws(() => AuditJsonl.parse('\n'.repeat(AuditJsonl.MAX_LINES + 1)), /上限/);
});

test('⑨ 读类工具的 path 参数不得计入文件变更（防伪造证据）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omni-audit-'));
  const file = join(dir, 'mixed.jsonl');
  const base = { sessionId: 's', timestamp: '2026-11-02T00:00:00.000Z' };
  writeFileSync(
    file,
    [
      JSON.stringify({
        ...base,
        type: 'tool_call',
        payload: { callId: 'r1', name: 'read_file', args: { path: 'README.md' } },
      }),
      JSON.stringify({
        ...base,
        type: 'tool_call',
        payload: { callId: 'w1', name: 'write_file', args: { path: 'src/z.ts' } },
      }),
      JSON.stringify({
        ...base,
        type: 'tool_call',
        payload: { callId: 'd1', name: 'list_dir', args: { path: '.' } },
      }),
    ].join('\n'),
  );
  const calls = loader.load(file).result.records.filter((record) => record.kind === 'tool_call');
  assert.strictEqual(calls[0]?.files, undefined);
  assert.deepStrictEqual(calls[1]?.files, ['src/z.ts']);
  assert.strictEqual(calls[2]?.files, undefined);
});

test('⑩ 兼容 session export 信封（单对象 events[]）', () => {
  const loaded = loader.load(join(FIXTURES, 'envelope', 'omni-envelope.json'));
  assert.strictEqual(loaded.result.format, 'omni');
  assert.strictEqual(loaded.result.sessionId, 'omni-2');
  assert.strictEqual(loaded.result.workspace, '/exported');
  assert.deepStrictEqual(
    loaded.result.records.map((record) => record.kind),
    ['session', 'user', 'tool_call'],
  );
  assert.deepStrictEqual(loaded.result.records[2]?.files, ['src/d.ts']);
  // 信封也可能被格式化工具排成多行（提交钩子实测会这么做）：按全文解析，不能假设"一行一事件"。
  const pretty = JSON.stringify(
    JSON.parse(readFileSync(join(FIXTURES, 'envelope', 'omni-envelope.json'), 'utf8')),
    null,
    2,
  );
  const multiline = new OmniSessionParser().parse(pretty);
  assert.strictEqual(multiline.sessionId, 'omni-2');
  assert.strictEqual(multiline.records.length, 3);
});

test('⑪ 未识别条目可见化：omni 漂移夹具计 3、正常夹具计 0（未知类型以 other 保留）', () => {
  const drift = loader.load(join(FIXTURES, 'drift-mixed.jsonl'));
  assert.strictEqual(drift.result.format, 'omni');
  assert.strictEqual(drift.result.unrecognized, 3);
  // 3 条未知类型仍以 other 记录进入时间线（证据不丢）+ session/user/assistant 各 1。
  assert.strictEqual(drift.result.records.length, 6);
  assert.strictEqual(drift.result.records.filter((record) => record.kind === 'other').length, 3);
  const clean = loader.load(join(FIXTURES, 'omni.jsonl'));
  assert.strictEqual(clean.result.unrecognized, 0);
});

test('⑫ 未识别条目可见化：ACP 未知 method / 未知 update 类别 / 坏行都计入', () => {
  const file = join(tmpdir(), `omni-acp-drift-${String(Date.now())}.jsonl`);
  writeFileSync(
    file,
    [
      JSON.stringify({ jsonrpc: '2.0', method: 'session/new', params: { cwd: '/repo' } }),
      JSON.stringify({ jsonrpc: '2.0', method: 'future/method', params: {} }),
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'session/update',
        params: { update: { sessionUpdate: 'future_chunk', content: { text: 'x' } } },
      }),
      JSON.stringify({ jsonrpc: '2.0', method: 'session/prompt', params: { prompt: 'hi' } }),
      'not json at all',
    ].join('\n'),
  );
  const loaded = loader.load(file);
  assert.strictEqual(loaded.result.format, 'acp');
  // future/method + future_chunk + 坏行 = 3（原来三者全部静默丢弃）。
  assert.strictEqual(loaded.result.unrecognized, 3);
  assert.strictEqual(loaded.result.records.length, 2);
});
