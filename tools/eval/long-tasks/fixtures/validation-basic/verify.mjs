// 机械验收器（评测前由 runner 从 verifiers/ 覆盖写入；agent 对 verify.mjs 的改动不算数）。
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mod = require('./src/index.js');
const names = ['isEmailLike', 'isHexColor', 'isStrongPassword'];
for (const name of names) {
  assert.strictEqual(typeof mod[name], 'function', '缺少导出函数 ' + name);
}

assert.strictEqual(mod.isEmailLike('a@b.co'), true);
assert.strictEqual(mod.isEmailLike('a@b'), false);
assert.strictEqual(mod.isEmailLike('a b@c.co'), false);
assert.strictEqual(mod.isEmailLike(42), false);
assert.strictEqual(mod.isHexColor('#abc'), true);
assert.strictEqual(mod.isHexColor('#123456'), true);
assert.strictEqual(mod.isHexColor('#abcd'), false);
assert.strictEqual(mod.isStrongPassword('Aa123456'), true);
assert.strictEqual(mod.isStrongPassword('aa123456'), false);
assert.strictEqual(mod.isStrongPassword('Aa12'), false);

const readme = existsSync('README.md') ? readFileSync('README.md', 'utf8') : '';
assert.ok(readme.trim() !== '', 'README.md 缺失或为空');
for (const name of names) {
  assert.ok(readme.includes(name), 'README.md 未提到 ' + name);
}
console.log('verify ok');
