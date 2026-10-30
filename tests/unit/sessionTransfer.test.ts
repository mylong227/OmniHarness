/**
 * 会话**导出/导入**判据（U3 平台互操作第一片，2026-10-31）。
 *
 * 钉住五条不变量：① omni 信封自描述且 events 原样；② **导出→导入 round-trip**：
 * 经真实 `JsonlStorage` 落盘后事件流与源逐位一致（除 id/seq/sessionId/workspace 四个重编位）；
 * ③ Claude Code 最小投影只取文本、跳过计数如实；④ 未知格式 fail-closed（不猜）；
 * ⑤ 重编确定性（同输入两次结果逐位一致）。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonlStorage } from '../../src/adapters/storage/jsonlStorage.ts';
import { SessionTransfer } from '../../src/cli/sessionTransfer.ts';
import type { SessionEvent } from '../../src/ports/runtime/event.ts';

const WORKSPACE = 'D:\\prov\\ws';

/** 一段有代表性的源事件（含工具轮与 turn_diff）。 */
function sourceEvents(sessionId: string): readonly SessionEvent[] {
  return [
    {
      id: 'evt_a1',
      type: 'session_meta',
      sessionId,
      timestamp: '2026-10-31T00:00:00.000Z',
      payload: { workspace: 'D:\\other\\proj' },
    },
    {
      id: 'evt_a2',
      type: 'user',
      sessionId,
      timestamp: '2026-10-31T00:00:01.000Z',
      payload: { content: '修一下登录' },
    },
    {
      id: 'evt_a3',
      type: 'tool_call',
      sessionId,
      timestamp: '2026-10-31T00:00:02.000Z',
      payload: { callId: 'c1', name: 'edit', args: { path: 'a.ts' } },
    },
    {
      id: 'evt_a4',
      type: 'tool_result',
      sessionId,
      timestamp: '2026-10-31T00:00:03.000Z',
      payload: { callId: 'c1', ok: true, output: 'ok' },
    },
    {
      id: 'evt_a5',
      type: 'assistant',
      sessionId,
      timestamp: '2026-10-31T00:00:04.000Z',
      payload: { content: '改完了' },
    },
    {
      id: 'evt_a6',
      type: 'turn_diff',
      sessionId,
      seq: 6,
      timestamp: '2026-10-31T00:00:05.000Z',
      payload: { diff: '--- a\n+++ b' },
    },
  ];
}

/** 临时 JsonlStorage（用完即删）。 */
function tempStorage(): { storage: JsonlStorage; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'omni-sess-transfer-'));
  return {
    storage: new JsonlStorage(dir),
    cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 10 }),
  };
}

test('① 导出：信封自描述，events 与存储逐位一致', async () => {
  const { storage, cleanup } = tempStorage();
  try {
    const src = sourceEvents('sess_src_1');
    await storage.save('sess_src_1', src);

    const envelope = await SessionTransfer.exportSession(storage, 'sess_src_1');

    assert.strictEqual(envelope.format, 'omniharness.session.v1');
    assert.strictEqual(envelope.sourceSessionId, 'sess_src_1');
    assert.strictEqual(envelope.eventCount, 6);
    assert.deepStrictEqual(envelope.events, src, '导出必须无损（逐位一致）');
  } finally {
    cleanup();
  }
});

test('② round-trip：导出→导入→落盘读回，除重编位外逐位一致', async () => {
  const a = tempStorage();
  const b = tempStorage();
  try {
    const src = sourceEvents('sess_src_2');
    await a.storage.save('sess_src_2', src);
    const envelope = await SessionTransfer.exportSession(a.storage, 'sess_src_2');

    const parsed = SessionTransfer.parseImport(JSON.stringify(envelope), {
      workspace: WORKSPACE,
      sessionId: 'sess_new_9',
    });
    assert.strictEqual(parsed.source, 'omni');
    assert.strictEqual(parsed.skipped, 0);
    await SessionTransfer.importSession(b.storage, parsed.events, 'sess_new_9');

    const loaded = await b.storage.load('sess_new_9');
    assert.strictEqual(loaded.length, 6);
    // 重编位：id 重排 / sessionId 换新 / seq 重置 / meta 的 workspace 归导入方。
    assert.deepStrictEqual(
      loaded.map((e) => e.id),
      ['evt_imp0001', 'evt_imp0002', 'evt_imp0003', 'evt_imp0004', 'evt_imp0005', 'evt_imp0006'],
    );
    for (const event of loaded) {
      assert.strictEqual(event.sessionId, 'sess_new_9', '落盘前必须带上新会话 id');
      assert.strictEqual(event.seq, undefined, '旧 seq 不得残留（避免与重编 id 错位）');
    }
    // 语义位逐位一致：payload 原样、timestamp 原样、类型序列一致（meta 除外——
    // 它的 workspace 按设计重写为导入方，见下一条断言）。
    assert.deepStrictEqual(
      loaded.slice(1).map((e) => [e.type, e.payload, e.timestamp]),
      src.slice(1).map((e) => [e.type, e.payload, e.timestamp]),
    );
    const meta = loaded[0];
    assert.deepStrictEqual(meta?.payload, { workspace: WORKSPACE }, 'meta 的 workspace 归导入方');
  } finally {
    a.cleanup();
    b.cleanup();
  }
});

test('③ Claude Code 投影：只取文本；导入映射 user/assistant，跳过计数如实', async () => {
  const { storage, cleanup } = tempStorage();
  try {
    const src = sourceEvents('sess_src_3');
    await storage.save('sess_src_3', src);
    const envelope = await SessionTransfer.exportSession(storage, 'sess_src_3');

    const jsonl = SessionTransfer.renderClaudeCode(envelope);
    const lines = jsonl.trim().split('\n');
    assert.strictEqual(lines.length, 2, '只投影 user/assistant 文本（4 个非文本事件被略去）');
    const first = JSON.parse(lines[0] ?? '{}') as { type: string; message: { content: string } };
    assert.strictEqual(first.type, 'user');
    assert.strictEqual(first.message.content, '修一下登录');

    const parsed = SessionTransfer.parseImport(jsonl, {
      workspace: WORKSPACE,
      sessionId: 'sess_cc_1',
    });
    assert.strictEqual(parsed.source, 'claude-code');
    assert.strictEqual(parsed.skipped, 0, '全部行都是可映射的 user/assistant ⇒ skipped=0');
    assert.strictEqual(parsed.events.length, 3, 'meta + user + assistant');
    assert.strictEqual(parsed.events[0]?.type, 'session_meta');
    assert.deepStrictEqual(parsed.events[0]?.payload, { workspace: WORKSPACE });
    assert.strictEqual(parsed.events[1]?.type, 'user');
    assert.deepStrictEqual(parsed.events[1]?.payload, { content: '修一下登录' });
    assert.strictEqual(parsed.events[2]?.type, 'assistant');
  } finally {
    cleanup();
  }
});

test('③b Claude Code 导入：tool_use/tool_result/summary/system 行跳过并计数', () => {
  const jsonl = [
    JSON.stringify({ type: 'summary', summary: '聊天摘要' }),
    JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: '第一条' }] },
    }),
    JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 't1', name: 'edit' },
          { type: 'text', text: '回答' },
        ],
      },
    }),
    JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }],
      },
    }),
    '这不是 JSON 的一行',
  ].join('\n');

  const parsed = SessionTransfer.parseImport(jsonl, {
    workspace: WORKSPACE,
    sessionId: 'sess_cc_2',
  });

  assert.strictEqual(parsed.source, 'claude-code');
  assert.strictEqual(parsed.skipped, 3, 'summary / tool_result-only / 非 JSON 行各跳过 1');
  assert.strictEqual(parsed.events.length, 3, 'meta + user文本 + assistant文本');
  assert.deepStrictEqual(parsed.events[2]?.payload, { content: '回答' }, 'tool_use 块不进文本');
});

test('④ fail-closed：空文件 / 未知格式 / 缺 events 都抛错不猜', () => {
  assert.throws(
    () => SessionTransfer.parseImport('', { workspace: WORKSPACE, sessionId: 'x' }),
    /为空/u,
  );
  assert.throws(
    () =>
      SessionTransfer.parseImport('{"format":"别的格式","events":[]}', {
        workspace: WORKSPACE,
        sessionId: 'x',
      }),
    /无法识别|为空|缺/u,
    '未知 format 且不是 CC JSONL ⇒ 必须抛错',
  );
  assert.throws(
    () =>
      SessionTransfer.parseImport(
        JSON.stringify({ format: 'omniharness.session.v1', events: '不是数组' }),
        { workspace: WORKSPACE, sessionId: 'x' },
      ),
    /events 数组/u,
  );
});

test('⑤ 确定性：同输入两次解析结果逐位一致', () => {
  const jsonl = `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' }, timestamp: '2026-10-31T01:02:03Z' })}\n`;
  const one = SessionTransfer.parseImport(jsonl, { workspace: WORKSPACE, sessionId: 's1' });
  const two = SessionTransfer.parseImport(jsonl, { workspace: WORKSPACE, sessionId: 's1' });
  assert.deepStrictEqual(one, two);
});
