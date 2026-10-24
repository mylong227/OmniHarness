// 机械验收器（评测前由 runner 从 verifiers/ 覆盖写入；agent 对 verify.mjs 的改动不算数）。
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mod = require('./src/index.js');
const names = ['createLru'];
for (const name of names) {
  assert.strictEqual(typeof mod[name], 'function', '缺少导出函数 ' + name);
}

const lru = mod.createLru(2);
lru.set('a', 1);
assert.strictEqual(lru.get('a'), 1);
lru.set('b', 2);
lru.set('c', 3);
assert.deepStrictEqual(lru.keys(), ['b', 'c']);
assert.strictEqual(lru.get('a'), undefined);
assert.strictEqual(lru.get('b'), 2);
lru.set('b', 20);
assert.strictEqual(lru.size(), 2);
assert.deepStrictEqual(lru.keys(), ['c', 'b']);
const none = mod.createLru(0);
none.set('x', 1);
assert.strictEqual(none.size(), 0);
assert.strictEqual(none.get('x'), undefined);

const readme = existsSync('README.md') ? readFileSync('README.md', 'utf8') : '';
assert.ok(readme.trim() !== '', 'README.md 缺失或为空');
for (const name of names) {
  assert.ok(readme.includes(name), 'README.md 未提到 ' + name);
}
console.log('verify ok');
