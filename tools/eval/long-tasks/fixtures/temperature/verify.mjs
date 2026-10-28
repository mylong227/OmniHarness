import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mod = require('./src/index.js');
const names = ['cToF', 'fToC', 'convertTemperature'];
for (const name of names) {
  assert.strictEqual(typeof mod[name], 'function', '缺少导出函数 ' + name);
}

assert.strictEqual(mod.cToF(0), 32);
assert.strictEqual(mod.cToF(100), 212);
assert.strictEqual(mod.fToC(32), 0);
assert.strictEqual(mod.fToC(212), 100);
assert.strictEqual(mod.convertTemperature(0, 'C', 'K'), 273.15);
assert.strictEqual(mod.convertTemperature(273.15, 'K', 'C'), 0);
assert.throws(() => mod.convertTemperature(1, 'X', 'C'));

const readme = existsSync('README.md') ? readFileSync('README.md', 'utf8') : '';
assert.ok(readme.trim() !== '', 'README.md 缺失或为空');
for (const name of names) assert.ok(readme.includes(name), 'README.md 未提到 ' + name);
console.log('verify ok');
