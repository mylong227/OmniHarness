// 机械验收器（评测前由 runner 从 verifiers/ 覆盖写入；agent 对 verify.mjs 的改动不算数）。
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mod = require('./src/index.js');
const names = ['safeJsonParse', 'flattenObject', 'countKeys'];
for (const name of names) {
  assert.strictEqual(typeof mod[name], 'function', '缺少导出函数 ' + name);
}

assert.deepStrictEqual(mod.safeJsonParse('{"a":1}', {}), { a: 1 });
assert.deepStrictEqual(mod.safeJsonParse('nope', { fallback: true }), { fallback: true });
assert.deepStrictEqual(mod.flattenObject({ a: { b: 1 }, c: 2 }), { 'a.b': 1, c: 2 });
assert.deepStrictEqual(mod.flattenObject({ a: { b: { c: 3 } } }), { 'a.b.c': 3 });
assert.deepStrictEqual(mod.flattenObject({ list: [1, 2] }), { list: [1, 2] });
assert.strictEqual(mod.countKeys({ a: { b: 1 }, c: 2 }), 2);

const readme = existsSync('README.md') ? readFileSync('README.md', 'utf8') : '';
assert.ok(readme.trim() !== '', 'README.md 缺失或为空');
for (const name of names) {
  assert.ok(readme.includes(name), 'README.md 未提到 ' + name);
}
console.log('verify ok');
