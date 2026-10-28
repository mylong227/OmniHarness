import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mod = require('./src/index.js');
const names = ['clamp', 'lerp', 'roundTo'];
for (const name of names) {
  assert.strictEqual(typeof mod[name], 'function', '缺少导出函数 ' + name);
}

assert.strictEqual(mod.clamp(5, 0, 3), 3);
assert.strictEqual(mod.clamp(-1, 0, 3), 0);
assert.strictEqual(mod.clamp(2, 0, 3), 2);
assert.strictEqual(mod.lerp(0, 10, 0.25), 2.5);
assert.strictEqual(mod.lerp(10, 0, 0.5), 5);
assert.strictEqual(mod.roundTo(1.2345, 2), 1.23);
assert.strictEqual(mod.roundTo(1.2355, 2), 1.24);
assert.strictEqual(mod.roundTo(1234, -2), 1200);

const readme = existsSync('README.md') ? readFileSync('README.md', 'utf8') : '';
assert.ok(readme.trim() !== '', 'README.md 缺失或为空');
for (const name of names) assert.ok(readme.includes(name), 'README.md 未提到 ' + name);
console.log('verify ok');
