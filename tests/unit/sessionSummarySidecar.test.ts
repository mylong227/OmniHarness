/**
 * 会话旁路摘要回归判据（2026-10-25，S1）。
 *
 * 钉住三件事：
 *  1. `SessionSummaryBuilder` 的口径（回合数 / 首条标签 / 空闲剔除 / workspace/model/mock）；
 *  2. 旁路有效时 `SessionScanCache.readSummary` **完全不解析 `.jsonl`**（文件内容故意写成非法 JSON）；
 *  3. 旁路过期（size 不符）时回落解析，并最终把正确旁路写回。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionScanCache } from '../../src/server/services/session/sessionScanCache.ts';
import { JsonlStorage } from '../../src/adapters/storage/jsonlStorage.ts';
import { SessionSummaryBuilder } from '../../src/util/sessionSummary.ts';
import {
  readSessionSummary,
  sessionSummaryPath,
  writeSessionSummary,
} from '../../src/util/sessionSummarySidecar.ts';
import type { SessionEvent } from '../../src/ports/runtime/event.ts';
import type { EventType } from '../../src/ports/runtime/event/eventType.ts';

/** 造一条最小事件。 */
function event(
  type: EventType,
  timestamp: string,
  payload: Record<string, unknown> = {},
): SessionEvent {
  return { id: `${type}-${timestamp}`, sessionId: 's', type, timestamp, payload };
}

test('SessionSummaryBuilder：回合数 / 标签 / 空闲剔除 / workspace / model / mock', () => {
  const t0 = Date.parse('2026-10-25T00:00:00.000Z');
  const events: SessionEvent[] = [
    event('session_meta', new Date(t0).toISOString(), { workspace: 'D:\\ws', model: 'm1' }),
    event('user', new Date(t0).toISOString(), { content: '第一个问题' }),
    event('assistant', new Date(t0 + 1_000).toISOString(), { content: '回答' }),
    // 10 分钟后用户回来 ⇒ 该间隔应被剔除。
    event('user', new Date(t0 + 600_000).toISOString(), { content: '又来了' }),
  ];
  const summary = SessionSummaryBuilder.fromEvents(events);
  assert.strictEqual(summary.turns, 2);
  assert.strictEqual(summary.label, '第一个问题');
  assert.strictEqual(summary.workspace, 'D:\\ws');
  assert.strictEqual(summary.model, 'm1');
  assert.strictEqual(summary.idleGaps, 1);
  assert.strictEqual(summary.activeMs, 1_000, '10 分钟空闲应从有效时长里剔除');
  assert.strictEqual(summary.updatedAt, new Date(t0 + 600_000).toISOString());
});

test('旁路有效：readSummary 不解析 .jsonl（内容是非法 JSON 也能返回旁路摘要）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omni-sidecar-'));
  try {
    const file = join(dir, 'sess_1.jsonl');
    const raw = 'this-is-not-json';
    writeFileSync(file, raw, 'utf8');
    const summary = SessionSummaryBuilder.fromEvents([
      event('user', '2026-10-25T00:00:00.000Z', { content: '来自旁路' }),
    ]);
    assert.strictEqual(await writeSessionSummary(file, Buffer.byteLength(raw), summary), true);
    const read = await new SessionScanCache().readSummary(file);
    assert.strictEqual(read?.value.label, '来自旁路');
    assert.strictEqual(read?.value.turns, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('旁路过期（size 不符）：回落解析并回写正确旁路', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omni-sidecar-stale-'));
  try {
    const file = join(dir, 'sess_2.jsonl');
    const lines = [
      event('session_meta', '2026-10-25T00:00:00.000Z', { workspace: 'D:\\ws' }),
      event('user', '2026-10-25T00:00:01.000Z', { content: '真实内容' }),
    ].map((item) => JSON.stringify(item));
    writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
    const size = statSync(file).size;
    // size 故意写错 ⇒ 必须回落解析。
    await writeSessionSummary(
      file,
      size - 1,
      SessionSummaryBuilder.fromEvents([event('user', '2026-10-25T00:00:00.000Z')]),
    );
    const cache = new SessionScanCache();
    const read = await cache.readSummary(file);
    assert.strictEqual(read?.value.label, '真实内容');
    assert.strictEqual(read?.value.workspace, 'D:\\ws');
    // 回写是异步尽力而为：轮询等待旁路 size 变为真实大小。
    // 全量套件并发时机器负载会让写盘排队，500ms 会偶发假红；给到 5s（仍是有界等待）。
    const expected = size;
    let fixed = false;
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const side = await readSessionSummary(file);
      if (side?.size === expected) {
        fixed = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.strictEqual(fixed, true, '过期旁路应被正确摘要替换');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('JsonlStorage.save 同步写旁路摘要（size 与 .jsonl 一致）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omni-sidecar-save-'));
  try {
    const storage = new JsonlStorage(dir);
    const events: SessionEvent[] = [event('user', '2026-10-25T00:00:00.000Z', { content: '落盘' })];
    await storage.save('sess_3', events);
    const file = join(dir, 'sess_3.jsonl');
    const side = await readSessionSummary(file);
    assert.ok(side !== undefined, 'save 后必须存在旁路');
    assert.strictEqual(side?.size, statSync(file).size);
    assert.strictEqual(side?.summary.label, '落盘');
    assert.ok(readFileSync(sessionSummaryPath(file), 'utf8').includes('"version":1'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
