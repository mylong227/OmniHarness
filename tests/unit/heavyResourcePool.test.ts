import { test } from 'vitest';
import assert from 'node:assert/strict';
import { HeavyResourcePool } from '../helpers/heavyResourcePool.ts';

test('HeavyResourcePool：槽数默认 1，OMNI_HEAVY_SLOTS=2 生效', () => {
  const previous = process.env['OMNI_HEAVY_SLOTS'];
  try {
    delete process.env['OMNI_HEAVY_SLOTS'];
    assert.strictEqual(HeavyResourcePool.slotCount(), 1);
    process.env['OMNI_HEAVY_SLOTS'] = '2';
    assert.strictEqual(HeavyResourcePool.slotCount(), 2);
    process.env['OMNI_HEAVY_SLOTS'] = '0';
    assert.strictEqual(HeavyResourcePool.slotCount(), 1, '非法槽数必须回落 1');
  } finally {
    if (previous === undefined) delete process.env['OMNI_HEAVY_SLOTS'];
    else process.env['OMNI_HEAVY_SLOTS'] = previous;
  }
});

test('HeavyResourcePool：获取/释放幂等，释放后可再次获取', async () => {
  const previous = process.env['OMNI_HEAVY_SLOTS'];
  process.env['OMNI_HEAVY_SLOTS'] = '3';
  try {
    const release = await HeavyResourcePool.acquire('pool-test');
    release();
    release(); // 幂等
    const again = await HeavyResourcePool.acquire('pool-test-2');
    again();
  } finally {
    if (previous === undefined) delete process.env['OMNI_HEAVY_SLOTS'];
    else process.env['OMNI_HEAVY_SLOTS'] = previous;
  }
});
