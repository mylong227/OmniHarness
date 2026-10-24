// 机械验收器（评测前由 runner 从 verifiers/ 覆盖写入；agent 对 verify.mjs 的改动不算数）。
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mod = require('./src/index.js');
const names = ['intersection', 'difference', 'union'];
for (const name of names) {
  assert.strictEqual(typeof mod[name], 'function', '缺少导出函数 ' + name);
}

assert.deepStrictEqual(mod.intersection([1, 2, 2, 3], [2, 3, 4]), [2, 3]);
assert.deepStrictEqual(mod.intersection([], [1]), []);
assert.deepStrictEqual(mod.difference([1, 2, 2, 3], [2]), [1, 3]);
assert.deepStrictEqual(mod.difference([1], [1]), []);
assert.deepStrictEqual(mod.union([1, 2], [2, 3]), [1, 2, 3]);

const readme = existsSync('README.md') ? readFileSync('README.md', 'utf8') : '';
assert.ok(readme.trim() !== '', 'README.md 缺失或为空');
for (const name of names) {
  assert.ok(readme.includes(name), 'README.md 未提到 ' + name);
}
console.log('verify ok');
