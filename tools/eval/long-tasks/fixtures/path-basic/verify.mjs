// 机械验收器（评测前由 runner 从 verifiers/ 覆盖写入；agent 对 verify.mjs 的改动不算数）。
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mod = require('./src/index.js');
const names = ['joinPath', 'basenameNoExt', 'isAbsolutePath'];
for (const name of names) {
  assert.strictEqual(typeof mod[name], 'function', '缺少导出函数 ' + name);
}

assert.strictEqual(mod.joinPath('a', 'b', 'c'), 'a/b/c');
assert.strictEqual(mod.joinPath('a/', '/b/'), 'a/b');
assert.strictEqual(mod.joinPath('a', '..', 'b'), 'b');
assert.strictEqual(mod.joinPath('/x', '..', 'y'), '/y');
assert.strictEqual(mod.joinPath('..', 'a'), '../a');
assert.strictEqual(mod.basenameNoExt('src/foo.test.js'), 'foo.test');
assert.strictEqual(mod.basenameNoExt('Makefile'), 'Makefile');
assert.strictEqual(mod.basenameNoExt('.gitignore'), '.gitignore');
assert.strictEqual(mod.isAbsolutePath('/x'), true);
assert.strictEqual(mod.isAbsolutePath('C:\\x'), true);
assert.strictEqual(mod.isAbsolutePath('a/b'), false);

const readme = existsSync('README.md') ? readFileSync('README.md', 'utf8') : '';
assert.ok(readme.trim() !== '', 'README.md 缺失或为空');
for (const name of names) {
  assert.ok(readme.includes(name), 'README.md 未提到 ' + name);
}
console.log('verify ok');
