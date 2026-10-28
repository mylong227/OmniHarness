import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mod = require('./src/index.js');
const names = ['isValidCard', 'generateCheckDigit', 'maskCard'];
for (const name of names) {
  assert.strictEqual(typeof mod[name], 'function', '缺少导出函数 ' + name);
}

assert.strictEqual(mod.isValidCard('79927398713'), true);
assert.strictEqual(mod.isValidCard('7992 7398 713'), true);
assert.strictEqual(mod.isValidCard('79927398710'), false);
assert.strictEqual(mod.isValidCard('abc'), false);

assert.strictEqual(mod.generateCheckDigit('7992739871'), 3);
assert.throws(() => mod.generateCheckDigit('12a'));

assert.strictEqual(mod.maskCard('1234567890123456'), '************3456');
assert.strictEqual(mod.maskCard('1234'), '1234');

const readme = existsSync('README.md') ? readFileSync('README.md', 'utf8') : '';
assert.ok(readme.trim() !== '', 'README.md 缺失或为空');
for (const name of names) assert.ok(readme.includes(name), 'README.md 未提到 ' + name);
console.log('verify ok');
