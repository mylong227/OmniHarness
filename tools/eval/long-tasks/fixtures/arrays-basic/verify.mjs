// 机械验收器（评测前由 runner 从 verifiers/ 覆盖写入；agent 对 verify.mjs 的改动不算数）。
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mod = require('./src/index.js');
const names = ['chunk', 'uniqueBy', 'flattenDeep'];
for (const name of names) {
  assert.strictEqual(typeof mod[name], 'function', '缺少导出函数 ' + name);
}

assert.deepStrictEqual(mod.chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
assert.deepStrictEqual(mod.chunk([1], 0), []);
assert.deepStrictEqual(
  mod.uniqueBy(
    [
      { id: 1, v: 'a' },
      { id: 2, v: 'b' },
      { id: 1, v: 'c' },
    ],
    'id',
  ),
  [
    { id: 1, v: 'a' },
    { id: 2, v: 'b' },
  ],
);
assert.deepStrictEqual(mod.flattenDeep([1, [2, [3, [4]]], 5]), [1, 2, 3, 4, 5]);
assert.deepStrictEqual(mod.flattenDeep([]), []);

const readme = existsSync('README.md') ? readFileSync('README.md', 'utf8') : '';
assert.ok(readme.trim() !== '', 'README.md 缺失或为空');
for (const name of names) {
  assert.ok(readme.includes(name), 'README.md 未提到 ' + name);
}
console.log('verify ok');
