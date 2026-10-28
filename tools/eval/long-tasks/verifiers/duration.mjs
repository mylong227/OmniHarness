import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mod = require('./src/index.js');
const names = ['formatDuration', 'parseDuration', 'isValidDuration'];
for (const name of names) {
  assert.strictEqual(typeof mod[name], 'function', '缺少导出函数 ' + name);
}

assert.strictEqual(mod.formatDuration(0), '0s');
assert.strictEqual(mod.formatDuration(90_000), '1m 30s');
assert.strictEqual(mod.formatDuration(3_600_000), '1h');
assert.strictEqual(mod.formatDuration(3_661_000), '1h 1m 1s');

assert.strictEqual(mod.parseDuration('1h30m'), 5_400_000);
assert.strictEqual(mod.parseDuration('90s'), 90_000);
assert.strictEqual(mod.parseDuration('2h'), 7_200_000);
assert.throws(() => mod.parseDuration('abc'));

assert.strictEqual(mod.isValidDuration('1h30m'), true);
assert.strictEqual(mod.isValidDuration('90'), false);
assert.strictEqual(mod.isValidDuration('abc'), false);

const readme = existsSync('README.md') ? readFileSync('README.md', 'utf8') : '';
assert.ok(readme.trim() !== '', 'README.md 缺失或为空');
for (const name of names) assert.ok(readme.includes(name), 'README.md 未提到 ' + name);
console.log('verify ok');
