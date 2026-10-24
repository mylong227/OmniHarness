// 机械验收器（评测前由 runner 从 verifiers/ 覆盖写入；agent 对 verify.mjs 的改动不算数）。
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mod = require('./src/index.js');
const names = ['slugify', 'readingTime', 'wordFrequency'];
for (const name of names) {
  assert.strictEqual(typeof mod[name], 'function', '缺少导出函数 ' + name);
}

assert.strictEqual(mod.slugify('Hello, World!'), 'hello-world');
assert.strictEqual(mod.slugify('  --x--  '), 'x');
assert.strictEqual(mod.readingTime('a '.repeat(200).trim()), 1);
assert.strictEqual(mod.readingTime('a '.repeat(201).trim()), 2);
assert.strictEqual(mod.readingTime(''), 0);
assert.deepStrictEqual(mod.wordFrequency('One two one'), { one: 2, two: 1 });

const readme = existsSync('README.md') ? readFileSync('README.md', 'utf8') : '';
assert.ok(readme.trim() !== '', 'README.md 缺失或为空');
for (const name of names) {
  assert.ok(readme.includes(name), 'README.md 未提到 ' + name);
}
console.log('verify ok');
