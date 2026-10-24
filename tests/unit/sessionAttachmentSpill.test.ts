/**
 * 大附件外置判据（2026-10-20）。
 *
 * 现场：单会话 7 张截图 = 6.28 MiB，占全部会话存档的 80%。落盘时把大附件移到
 * `sessions/attachments/<sessionId>/<sha256>.<ext>`，事件只留 path；回放时由
 * `ContextAssembler` 水合成 base64。本测试钉住「存档变小 / 回放仍能看到图」两端。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonlStorage } from '../../src/adapters/storage/jsonlStorage.ts';
import { SessionAttachmentSpiller } from '../../src/adapters/storage/sessionAttachmentSpiller.ts';
import { ContextAssembler } from '../../src/context/contextAssembler.ts';
import type { SessionEvent } from '../../src/ports/runtime/event/sessionEvent.ts';

/** 造一条携带附件的 tool_result。 */
const eventWith = (data: string): SessionEvent => ({
  id: 'e1',
  type: 'tool_result',
  sessionId: 's1',
  timestamp: '2026-10-20T00:00:00.000Z',
  payload: {
    callId: 'c1',
    ok: true,
    output: 'ok',
    files: [{ name: 'big.png', mediaType: 'image/png', data }],
  },
});

test('大附件外置：JSONL 不含 base64，回放时按路径水合', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'attach-spill-'));
  try {
    const data = Buffer.alloc(300 * 1024, 7).toString('base64'); // > 256K 字符
    const storage = new JsonlStorage(dir);
    await storage.save('s1', [eventWith(data)]);

    const text = readFileSync(join(dir, 's1.jsonl'), 'utf8');
    assert.ok(!text.includes('"data"'), 'JSONL 不得再内联 base64');
    assert.ok(text.includes('"path"'), '必须留下外置路径');
    assert.ok(text.length < 10_000, `存档应显著变小，实际 ${String(text.length)} 字符`);

    const loaded = await storage.load('s1');
    const file = (loaded[0]?.payload as { files?: { path?: string; data?: string }[] }).files?.[0];
    assert.ok(file?.path !== undefined, '读回事件应带 path');
    assert.ok(file?.path.startsWith('attachments/'), 'path 必须是相对 sessions 根的 POSIX 路径');
    assert.strictEqual(file?.data, undefined, '读回事件不应带 data');
    assert.ok(existsSync(join(dir, file.path)), '外置文件必须真实存在');

    const messages = new ContextAssembler([], dir).build(loaded);
    const attach = messages.find((m) => (m.files?.length ?? 0) > 0);
    assert.strictEqual(attach?.files?.[0]?.data, data, '投影时必须按 sessions 根水合回原字节');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('小附件保持内联（少一次 IO，测试夹具行为不变）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'attach-spill-'));
  try {
    const data = Buffer.from('small').toString('base64');
    const storage = new JsonlStorage(dir);
    await storage.save('s1', [eventWith(data)]);
    const text = readFileSync(join(dir, 's1.jsonl'), 'utf8');
    assert.ok(text.includes('"data"'), '小附件不应外置');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('内存事件外置：记录前把大附件换成 path（不需要等 JSONL 落盘）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'attach-spill-'));
  try {
    const data = Buffer.alloc(100 * 1024, 5).toString('base64');
    const spiller = new SessionAttachmentSpiller(dir);
    const files = await spiller.spillFiles('s1', [
      { name: 'shot.png', mediaType: 'image/png', data },
    ]);
    assert.strictEqual(files[0]?.data, undefined, '内存事件不应再持有 base64');
    assert.ok(files[0]?.path?.startsWith('attachments/'), '应留相对 sessions 根的 path');
    assert.ok(existsSync(join(dir, files[0]?.path ?? '')), '外置文件必须真实存在');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
