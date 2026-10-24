// 机械验收器（评测前由 runner 从 verifiers/ 覆盖写入；agent 对 verify.mjs 的改动不算数）。
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mod = require('./src/index.js');
const names = ['isLeapYear', 'daysInMonth', 'formatDuration'];
for (const name of names) {
  assert.strictEqual(typeof mod[name], 'function', '缺少导出函数 ' + name);
}

assert.strictEqual(mod.isLeapYear(2024), true);
assert.strictEqual(mod.isLeapYear(1900), false);
assert.strictEqual(mod.isLeapYear(2000), true);
assert.strictEqual(mod.daysInMonth(2024, 2), 29);
assert.strictEqual(mod.daysInMonth(2023, 2), 28);
assert.strictEqual(mod.daysInMonth(2023, 4), 30);
assert.strictEqual(mod.daysInMonth(2023, 13), 0);
assert.strictEqual(mod.formatDuration(3661000), '1h 1m 1s');
assert.strictEqual(mod.formatDuration(61000), '1m 1s');
assert.strictEqual(mod.formatDuration(500), '0s');
assert.strictEqual(mod.formatDuration(3600000), '1h');

const readme = existsSync('README.md') ? readFileSync('README.md', 'utf8') : '';
assert.ok(readme.trim() !== '', 'README.md 缺失或为空');
for (const name of names) {
  assert.ok(readme.includes(name), 'README.md 未提到 ' + name);
}
console.log('verify ok');
