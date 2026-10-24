// 机械验收器（评测前由 runner 从 verifiers/ 覆盖写入；agent 对 verify.mjs 的改动不算数）。
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mod = require('./src/index.js');
const names = ['toCamel', 'truncate', 'countWords'];
for (const name of names) {
  assert.strictEqual(typeof mod[name], 'function', '缺少导出函数 ' + name);
}

assert.strictEqual(mod.toCamel('foo bar_baz'), 'fooBarBaz');
assert.strictEqual(mod.toCamel('Hello world'), 'helloWorld');
assert.strictEqual(mod.toCamel(''), '');
assert.strictEqual(mod.truncate('abcdef', 4), 'abc…');
assert.strictEqual(mod.truncate('abc', 5), 'abc');
assert.strictEqual(mod.truncate('abc', 0), '');
assert.strictEqual(mod.countWords('  one two\tthree '), 3);
assert.strictEqual(mod.countWords('   '), 0);

const readme = existsSync('README.md') ? readFileSync('README.md', 'utf8') : '';
assert.ok(readme.trim() !== '', 'README.md 缺失或为空');
for (const name of names) {
  assert.ok(readme.includes(name), 'README.md 未提到 ' + name);
}
console.log('verify ok');
