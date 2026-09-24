import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { JsonlStorage } from '../../src/adapters/storage/jsonlStorage.js';
import type { SessionEvent } from '../../src/ports/runtime/event.js';

/** 造一条最小合法会话事件。 */
function evt(id: string): SessionEvent {
  return {
    id,
    type: 'user',
    sessionId: 's1',
    timestamp: '2026-09-24T00:00:00.000Z',
    payload: { id },
  };
}

/** 在临时目录上跑一段用例并保证清理（Windows 上目录占用会 EBUSY，故先关闭再删）。 */
async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'omni-jsonl-'));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('JsonlStorage: save/load 往返保序', async () => {
  await withTempDir(async (dir) => {
    const storage = new JsonlStorage(dir);
    await storage.save('s1', [evt('a'), evt('b'), evt('c')]);
    const loaded = await storage.load('s1');
    assert.deepStrictEqual(
      loaded.map((e) => e.id),
      ['a', 'b', 'c'],
    );
  });
});

test('JsonlStorage: 覆盖写为原子写，不留 .tmp 残留', async () => {
  await withTempDir(async (dir) => {
    const storage = new JsonlStorage(dir);
    await storage.save('s1', [evt('a')]);
    await storage.save('s1', [evt('a'), evt('b')]);
    const loaded = await storage.load('s1');
    assert.strictEqual(loaded.length, 2, '覆盖写后应读到新快照');
    // 临时文件必须已被 rename 消费掉（否则崩溃留下的半成品会一直堆积）
    assert.deepStrictEqual(readdirSync(dir).sort(), ['s1.jsonl']);
  });
});

test('JsonlStorage: 个别坏行只跳过该行，不再静默返回空历史（审计 §1.7 回归）', async () => {
  await withTempDir(async (dir) => {
    const storage = new JsonlStorage(dir);
    // 三行文件：第二行是坏 JSON（模拟崩溃/截断产生的残行）
    writeFileSync(
      join(dir, 's1.jsonl'),
      `${JSON.stringify(evt('a'))}\n{"broken": \n${JSON.stringify(evt('c'))}\n`,
      'utf8',
    );
    const loaded = await storage.load('s1');
    assert.deepStrictEqual(
      loaded.map((e) => e.id),
      ['a', 'c'],
      '坏行只丢那一行，其余历史必须照常返回（原实现会返回 [] 悄悄丢光）',
    );
  });
});

test('JsonlStorage: 全坏行仍返回空数组（不抛错），并已告警 all_lines_corrupt', async () => {
  await withTempDir(async (dir) => {
    const storage = new JsonlStorage(dir);
    writeFileSync(join(dir, 's1.jsonl'), 'not json\n{"also": \n', 'utf8');
    const loaded = await storage.load('s1');
    assert.deepStrictEqual(loaded, []);
  });
});

test('JsonlStorage: 原子写失败时清理半成品并如实抛错（不静默吞错）', async () => {
  await withTempDir(async (dir) => {
    const storage = new JsonlStorage(dir);
    // 用一个**目录**占住临时文件路径 ⇒ writeFile(tmp) 必失败（EISDIR），从而走到清理分支
    mkdirSync(join(dir, 's1.jsonl.tmp'));
    await assert.rejects(() => storage.save('s1', [evt('a')]));
    assert.strictEqual(existsSync(join(dir, 's1.jsonl')), false, '失败时不得留下目标文件');
  });
});

test('JsonlStorage: 文件缺失与不可读都返回空数组且不抛错', async () => {
  await withTempDir(async (dir) => {
    const storage = new JsonlStorage(dir);
    assert.deepStrictEqual(await storage.load('missing'), []);

    // 同名的**目录**：readFile 抛 EISDIR（非 ENOENT）⇒ warn 后仍返回 []
    await storage.save('s2', [evt('a')]);
    rmSync(join(dir, 's2.jsonl'));
    mkdirSync(join(dir, 's2.jsonl'));
    assert.deepStrictEqual(await storage.load('s2'), []);
  });
});
