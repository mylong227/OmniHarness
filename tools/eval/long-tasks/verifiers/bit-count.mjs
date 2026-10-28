import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mod = require('./src/index.js');
const names = ['bitCount', 'isPowerOfTwo', 'lowestBit'];
for (const name of names) {
  assert.strictEqual(typeof mod[name], 'function', '缺少导出函数 ' + name);
}

assert.strictEqual(mod.bitCount(0), 0);
assert.strictEqual(mod.bitCount(7), 3);
assert.strictEqual(mod.bitCount(256), 1);
assert.strictEqual(mod.bitCount(-1), 32, '负数按 32 位补码计');

assert.strictEqual(mod.isPowerOfTwo(1), true);
assert.strictEqual(mod.isPowerOfTwo(1024), true);
assert.strictEqual(mod.isPowerOfTwo(0), false);
assert.strictEqual(mod.isPowerOfTwo(6), false);

assert.strictEqual(mod.lowestBit(12), 4);
assert.strictEqual(mod.lowestBit(7), 1);
assert.strictEqual(mod.lowestBit(0), 0);

const readme = existsSync('README.md') ? readFileSync('README.md', 'utf8') : '';
assert.ok(readme.trim() !== '', 'README.md 缺失或为空');
for (const name of names) assert.ok(readme.includes(name), 'README.md 未提到 ' + name);
console.log('verify ok');
