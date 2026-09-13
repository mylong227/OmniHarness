import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionCheckpoints } from '../../src/server/services/sessionCheckpoints.js';
import { MemoryStorage } from '../../src/adapters/storage/memoryStorage.js';

function make(): SessionCheckpoints {
  return new SessionCheckpoints({ storage: new MemoryStorage() });
}

test('SessionCheckpoints：list 缺 sessionId 时抛错', async () => {
  await assert.rejects(() => make().list({}), /checkpoint.list 需要 sessionId/);
  await assert.rejects(() => make().list({ sessionId: '' }), /需要 sessionId/);
});

test('SessionCheckpoints：create 校验 sessionId 与 label', async () => {
  await assert.rejects(() => make().create({}), /checkpoint.create 需要 sessionId/);
  await assert.rejects(() => make().create({ sessionId: 's1' }), /checkpoint.create 需要 label/);
  await assert.rejects(
    () => make().create({ sessionId: 's1', label: '' }),
    /checkpoint.create 需要 label/,
  );
});

test('SessionCheckpoints：rollback 缺 sessionId 时抛错', async () => {
  await assert.rejects(() => make().rollback({}), /checkpoint.rollback 需要 sessionId/);
});

test('SessionCheckpoints：空存储下列表为空，回滚 fail-closed', async () => {
  const svc = make();
  assert.deepStrictEqual(await svc.list({ sessionId: 's1' }), {
    sessionId: 's1',
    checkpoints: [],
  });
  await assert.rejects(() => svc.rollback({ sessionId: 's1' }), /无可用检查点/);
});
