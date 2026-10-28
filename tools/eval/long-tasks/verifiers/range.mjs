import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mod = require('./src/index.js');
const names = ['range', 'sumRange', 'productRange'];
for (const name of names) {
  assert.strictEqual(typeof mod[name], 'function', '缺少导出函数 ' + name);
}

assert.deepStrictEqual(mod.range(0, 5), [0, 1, 2, 3, 4]);
assert.deepStrictEqual(mod.range(5, 0, -1), [5, 4, 3, 2, 1]);
assert.deepStrictEqual(mod.range(0, 0), []);
assert.deepStrictEqual(mod.range(0, 6, 2), [0, 2, 4]);
assert.throws(() => mod.range(0, 5, 0));

assert.strictEqual(mod.sumRange(1, 5), 10);
assert.strictEqual(mod.sumRange(5, 1), 10);
assert.strictEqual(mod.productRange(1, 5), 24);

const readme = existsSync('README.md') ? readFileSync('README.md', 'utf8') : '';
assert.ok(readme.trim() !== '', 'README.md 缺失或为空');
for (const name of names) assert.ok(readme.includes(name), 'README.md 未提到 ' + name);
console.log('verify ok');
