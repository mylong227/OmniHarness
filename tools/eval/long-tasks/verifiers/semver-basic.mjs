// 机械验收器（评测前由 runner 从 verifiers/ 覆盖写入；agent 对 verify.mjs 的改动不算数）。
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mod = require('./src/index.js');
const names = ['parseSemver', 'compareSemver', 'satisfiesCaret'];
for (const name of names) {
  assert.strictEqual(typeof mod[name], 'function', '缺少导出函数 ' + name);
}

assert.deepStrictEqual(mod.parseSemver('1.2.3'), { major: 1, minor: 2, patch: 3 });
assert.strictEqual(mod.parseSemver('1.2'), null);
assert.strictEqual(mod.compareSemver('1.2.3', '1.10.0'), -1);
assert.strictEqual(mod.compareSemver('2.0.0', '1.9.9'), 1);
assert.strictEqual(mod.compareSemver('1.0.0', '1.0.0'), 0);
assert.strictEqual(mod.satisfiesCaret('1.5.0', '^1.2.3'), true);
assert.strictEqual(mod.satisfiesCaret('2.0.0', '^1.2.3'), false);
assert.strictEqual(mod.satisfiesCaret('0.2.9', '^0.2.3'), true);
assert.strictEqual(mod.satisfiesCaret('0.2.2', '^0.2.3'), false);
assert.strictEqual(mod.satisfiesCaret('0.0.3', '^0.0.3'), true);
assert.strictEqual(mod.satisfiesCaret('0.0.4', '^0.0.3'), false);

const readme = existsSync('README.md') ? readFileSync('README.md', 'utf8') : '';
assert.ok(readme.trim() !== '', 'README.md 缺失或为空');
for (const name of names) {
  assert.ok(readme.includes(name), 'README.md 未提到 ' + name);
}
console.log('verify ok');
