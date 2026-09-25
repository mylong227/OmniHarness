import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Zip } from '../../src/plugin/zip.js';

test('crc32 已知向量', () => {
  // 经典校验向量：ASCII "123456789" 的 CRC32 = 0xCBF43926
  assert.strictEqual(Zip.crc32(Buffer.from('123456789', 'ascii')), 0xcbf43926);
  assert.strictEqual(Zip.crc32(Buffer.from('')), 0x00000000);
});

test('zipStore / unzip 往返一致（含子目录条目）', () => {
  const entries = [
    { name: 'a.txt', data: Buffer.from('hello') },
    { name: 'dir/b.txt', data: Buffer.from('world!!') },
    { name: 'bin', data: Buffer.from([0, 1, 2, 3, 255]) },
  ];
  const zipped = Zip.zipStore(entries);
  const back = Zip.unzip(zipped);
  assert.strictEqual(back.length, 3);
  const byName = new Map(back.map((e) => [e.name, e.data]));
  assert.strictEqual(byName.get('a.txt')?.toString('utf8'), 'hello');
  assert.strictEqual(byName.get('dir/b.txt')?.toString('utf8'), 'world!!');
  assert.deepStrictEqual([...byName.get('bin')!], [0, 1, 2, 3, 255]);
});

test('unzip 对非 zip 抛错', () => {
  assert.throws(() => Zip.unzip(Buffer.from('not a zip')));
});
