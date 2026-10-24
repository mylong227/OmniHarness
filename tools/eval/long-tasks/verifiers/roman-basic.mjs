// 机械验收器（评测前由 runner 从 verifiers/ 覆盖写入；agent 对 verify.mjs 的改动不算数）。
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mod = require('./src/index.js');
const names = ['toRoman', 'fromRoman', 'isValidRoman'];
for (const name of names) {
  assert.strictEqual(typeof mod[name], 'function', '缺少导出函数 ' + name);
}

assert.strictEqual(mod.toRoman(1994), 'MCMXCIV');
assert.strictEqual(mod.toRoman(4), 'IV');
assert.strictEqual(mod.toRoman(3999), 'MMMCMXCIX');
assert.strictEqual(mod.fromRoman('MCMXCIV'), 1994);
assert.ok(Number.isNaN(mod.fromRoman('ABC')));
assert.strictEqual(mod.isValidRoman('XIV'), true);
assert.strictEqual(mod.isValidRoman('IIII'), false);
assert.strictEqual(mod.isValidRoman(''), false);

const readme = existsSync('README.md') ? readFileSync('README.md', 'utf8') : '';
assert.ok(readme.trim() !== '', 'README.md 缺失或为空');
for (const name of names) {
  assert.ok(readme.includes(name), 'README.md 未提到 ' + name);
}
console.log('verify ok');
