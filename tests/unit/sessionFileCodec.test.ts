/**
 * 会话存档文件名编解码（2026-10-25）。
 *
 * 复现桌面截图缺陷：`checkpoint:<sid>:<label>` 直接拼文件名，Windows 上 `:` 非法 ⇒
 * `open(...checkpoint:sess...jsonl.tmp)` ENOENT。编码后必须能正常 save/load。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionFileCodec } from '../../src/util/sessionFileCodec.ts';
import { JsonlStorage } from '../../src/adapters/storage/jsonlStorage.ts';
import type { SessionEvent } from '../../src/ports/runtime/event.ts';

test('SessionFileCodec：普通 id 不变，非法字符转义且可逆', () => {
  assert.strictEqual(SessionFileCodec.encode('sess_abc-123'), 'sess_abc-123');
  const key = 'checkpoint:sess_abc:checkpoint-2026-10-25';
  const encoded = SessionFileCodec.encode(key);
  assert.ok(!encoded.includes(':'));
  assert.strictEqual(SessionFileCodec.decode(encoded), key);
  assert.strictEqual(SessionFileCodec.encode(encoded), encoded, '编码必须幂等');
});

test('JsonlStorage：合成 checkpoint key 能落盘/读回，文件名不含冒号', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omni-codec-'));
  try {
    const storage = new JsonlStorage(dir);
    const key = 'checkpoint:sess_mvnf0c8:checkpoint-2026-10-25-09-30-02';
    const events: SessionEvent[] = [
      {
        id: 'e1',
        sessionId: key,
        type: 'user',
        timestamp: '2026-10-25T09:30:02.000Z',
        payload: { content: 'hi' },
      },
    ];
    await storage.save(key, events);
    const names = readdirSync(dir);
    assert.ok(names.some((name) => name.endsWith('.jsonl')));
    assert.ok(
      names.every((name) => !name.includes(':')),
      `文件名不得含冒号：${names.join(',')}`,
    );
    assert.deepStrictEqual(await storage.load(key), events);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
