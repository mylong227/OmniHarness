import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mod = require('./src/index.js');
const names = ['toRoman', 'fromRoman', 'isRoman'];
for (const name of names) {
  assert.strictEqual(typeof mod[name], 'function', '缺少导出函数 ' + name);
}

assert.strictEqual(mod.toRoman(1), 'I');
assert.strictEqual(mod.toRoman(4), 'IV');
assert.strictEqual(mod.toRoman(1990), 'MCMXC');
assert.strictEqual(mod.toRoman(3999), 'MMMCMXCIX');
assert.throws(() => mod.toRoman(0));
assert.throws(() => mod.toRoman(4000));

assert.strictEqual(mod.fromRoman('MCMXC'), 1990);
assert.strictEqual(mod.fromRoman('IV'), 4);
assert.throws(() => mod.fromRoman('IIII'));
assert.throws(() => mod.fromRoman('ABC'));

assert.strictEqual(mod.isRoman('XIV'), true);
assert.strictEqual(mod.isRoman('IIII'), false);
assert.strictEqual(mod.isRoman(''), false);
assert.strictEqual(mod.isRoman('xiv'), false);

const readme = existsSync('README.md') ? readFileSync('README.md', 'utf8') : '';
assert.ok(readme.trim() !== '', 'README.md 缺失或为空');
for (const name of names) assert.ok(readme.includes(name), 'README.md 未提到 ' + name);
console.log('verify ok');
