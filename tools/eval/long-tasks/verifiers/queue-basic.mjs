// 机械验收器（评测前由 runner 从 verifiers/ 覆盖写入；agent 对 verify.mjs 的改动不算数）。
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mod = require('./src/index.js');
const names = ['createQueue'];
for (const name of names) {
  assert.strictEqual(typeof mod[name], 'function', '缺少导出函数 ' + name);
}

const queue = mod.createQueue(2);
assert.strictEqual(queue.size(), 0);
assert.strictEqual(queue.push(1), true);
assert.strictEqual(queue.push(2), true);
assert.strictEqual(queue.push(3), false);
assert.strictEqual(queue.isFull(), true);
assert.strictEqual(queue.shift(), 1);
assert.strictEqual(queue.shift(), 2);
assert.strictEqual(queue.shift(), undefined);
const empty = mod.createQueue(0);
assert.strictEqual(empty.push(1), false);
assert.strictEqual(empty.isFull(), true);

const readme = existsSync('README.md') ? readFileSync('README.md', 'utf8') : '';
assert.ok(readme.trim() !== '', 'README.md 缺失或为空');
for (const name of names) {
  assert.ok(readme.includes(name), 'README.md 未提到 ' + name);
}
console.log('verify ok');
