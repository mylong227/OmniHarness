// 机械验收器（评测前由 runner 从 verifiers/ 覆盖写入；agent 对 verify.mjs 的改动不算数）。
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mod = require('./src/index.js');
const names = ['parseQuery', 'buildQuery', 'normalizePath'];
for (const name of names) {
  assert.strictEqual(typeof mod[name], 'function', '缺少导出函数 ' + name);
}

assert.deepStrictEqual(mod.parseQuery('?a=1&b=two'), { a: '1', b: 'two' });
assert.deepStrictEqual(mod.parseQuery('a=1&a=2'), { a: '2' });
assert.strictEqual(mod.buildQuery({ a: 1, b: 'x y' }), 'a=1&b=x+y');
assert.strictEqual(mod.buildQuery({ a: undefined, b: 2 }), 'b=2');
assert.strictEqual(mod.normalizePath('a//b///c/'), 'a/b/c');
assert.strictEqual(mod.normalizePath('/'), '/');

const readme = existsSync('README.md') ? readFileSync('README.md', 'utf8') : '';
assert.ok(readme.trim() !== '', 'README.md 缺失或为空');
for (const name of names) {
  assert.ok(readme.includes(name), 'README.md 未提到 ' + name);
}
console.log('verify ok');
