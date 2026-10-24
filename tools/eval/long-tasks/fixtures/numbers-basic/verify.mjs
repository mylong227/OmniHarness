// 机械验收器（评测前由 runner 从 verifiers/ 覆盖写入；agent 对 verify.mjs 的改动不算数）。
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mod = require('./src/index.js');
const names = ['clamp', 'percent', 'sumTo'];
for (const name of names) {
  assert.strictEqual(typeof mod[name], 'function', '缺少导出函数 ' + name);
}

assert.strictEqual(mod.clamp(5, 0, 3), 3);
assert.strictEqual(mod.clamp(-1, 0, 3), 0);
assert.strictEqual(mod.clamp(2, 0, 3), 2);
assert.strictEqual(mod.percent(1, 4), 25);
assert.strictEqual(mod.percent(1, 3), 33.3);
assert.strictEqual(mod.percent(1, 0), 0);
assert.strictEqual(mod.sumTo(4), 10);
assert.strictEqual(mod.sumTo(0), 0);
assert.strictEqual(mod.sumTo(4.9), 10);

const readme = existsSync('README.md') ? readFileSync('README.md', 'utf8') : '';
assert.ok(readme.trim() !== '', 'README.md 缺失或为空');
for (const name of names) {
  assert.ok(readme.includes(name), 'README.md 未提到 ' + name);
}
console.log('verify ok');
