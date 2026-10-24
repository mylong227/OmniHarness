// 机械验收器（评测前由 runner 从 verifiers/ 覆盖写入；agent 对 verify.mjs 的改动不算数）。
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mod = require('./src/index.js');
const names = ['deepGet', 'pick', 'omit'];
for (const name of names) {
  assert.strictEqual(typeof mod[name], 'function', '缺少导出函数 ' + name);
}

assert.strictEqual(mod.deepGet({ a: { b: 1 } }, 'a.b', 0), 1);
assert.strictEqual(mod.deepGet({ a: {} }, 'a.c', 'x'), 'x');
assert.strictEqual(mod.deepGet({ a: null }, 'a.b', 5), 5);
assert.strictEqual(mod.deepGet({ a: { b: undefined } }, 'a.b', 'd'), 'd');
assert.deepStrictEqual(mod.pick({ a: 1, b: 2, c: 3 }, ['a', 'c']), { a: 1, c: 3 });
assert.deepStrictEqual(mod.pick({ a: 1 }, ['a', 'z']), { a: 1 });
assert.deepStrictEqual(mod.omit({ a: 1, b: 2 }, ['b']), { a: 1 });
assert.deepStrictEqual(mod.omit({ a: 1, b: 2 }, []), { a: 1, b: 2 });

const readme = existsSync('README.md') ? readFileSync('README.md', 'utf8') : '';
assert.ok(readme.trim() !== '', 'README.md 缺失或为空');
for (const name of names) {
  assert.ok(readme.includes(name), 'README.md 未提到 ' + name);
}
console.log('verify ok');
