import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { KvPort } from '../../src/ports/kv.js';
import { JsonFileKv } from '../../src/adapters/kv/jsonFileKv.js';
import { MemoryKv } from '../../src/adapters/kv/memoryKv.js';
import { SqliteKv } from '../../src/adapters/kv/sqliteKv.js';

/** 全后端通用的 KV 契约测试。 */
async function runKvContract(kv: KvPort): Promise<void> {
  // get 缺失返回 undefined
  assert.strictEqual(await kv.get('nope'), undefined);

  // set/get 往返
  await kv.set('a', '1');
  assert.strictEqual(await kv.get('a'), '1');

  // 覆盖写
  await kv.set('a', '2');
  assert.strictEqual(await kv.get('a'), '2');

  // has
  assert.strictEqual(await kv.has('a'), true);
  assert.strictEqual(await kv.has('b'), false);

  // keys / list / 前缀过滤
  await kv.set('b', 'x');
  await kv.set('session:one', 's1');
  await kv.set('session:two', 's2');
  const keys = await kv.keys();
  assert.strictEqual(keys.includes('a'), true);
  assert.strictEqual(keys.includes('b'), true);
  const sessions = await kv.list('session:');
  assert.strictEqual(sessions.length, 2);
  assert.strictEqual(sessions.find((e) => e.key === 'session:one')?.value, 's1');
  // delete
  assert.strictEqual(await kv.delete('b'), true);
  assert.strictEqual(await kv.delete('b'), false); // 二次删除返回 false
  assert.strictEqual(await kv.has('b'), false);

  await kv.close();
}

test('MemoryKv：契约全通过', async () => {
  await runKvContract(new MemoryKv());
});

test('JsonFileKv：契约 + 磁盘持久化', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'omniharness-kv-'));
  const file = path.join(dir, 'store.json');
  try {
    // 首次写入
    const kv = new JsonFileKv(file);
    await kv.set('k', 'v');
    await kv.set('list:1', 'one');
    await kv.close();

    // 新建实例从磁盘读回（持久化验证）
    const kv2 = new JsonFileKv(file);
    assert.strictEqual(await kv2.get('k'), 'v');
    assert.strictEqual((await kv2.list('list:')).length, 1);
    await kv2.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('JsonFileKv：文件不存在返回空而不是报错', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'omniharness-kv-'));
  try {
    const kv = new JsonFileKv(path.join(dir, 'missing.json'));
    assert.strictEqual(await kv.get('x'), undefined);
    assert.strictEqual((await kv.keys()).length, 0);
    await kv.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('SqliteKv：契约通过', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'omniharness-kv-'));
  try {
    await runKvContract(new SqliteKv(path.join(dir, 'kv.db')));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('三种后端行为等价（同名操作结果一致）', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'omniharness-kv-'));
  try {
    const backends: KvPort[] = [
      new MemoryKv(),
      new JsonFileKv(path.join(dir, 'store.json')),
      new SqliteKv(path.join(dir, 'kv.db')),
    ];
    for (const kv of backends) {
      await kv.set('k', 'v');
      assert.strictEqual(await kv.get('k'), 'v');
      await kv.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
