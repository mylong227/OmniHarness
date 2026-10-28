import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mod = require('./src/index.js');
const names = ['lowerBound', 'upperBound', 'searchRange'];
for (const name of names) {
  assert.strictEqual(typeof mod[name], 'function', '缺少导出函数 ' + name);
}

const sorted = [1, 2, 2, 2, 3, 5];
assert.strictEqual(mod.lowerBound(sorted, 2), 1);
assert.strictEqual(mod.upperBound(sorted, 2), 4);
assert.deepStrictEqual(mod.searchRange(sorted, 2), [1, 3]);
assert.deepStrictEqual(mod.searchRange(sorted, 4), [-1, -1]);
assert.deepStrictEqual(mod.searchRange([], 1), [-1, -1]);
assert.strictEqual(mod.lowerBound(sorted, 0), 0);
assert.strictEqual(mod.upperBound(sorted, 9), sorted.length);

const readme = existsSync('README.md') ? readFileSync('README.md', 'utf8') : '';
assert.ok(readme.trim() !== '', 'README.md 缺失或为空');
for (const name of names) assert.ok(readme.includes(name), 'README.md 未提到 ' + name);
console.log('verify ok');
