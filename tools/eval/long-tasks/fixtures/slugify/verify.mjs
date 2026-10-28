import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mod = require('./src/index.js');
const names = ['slugify', 'truncateSlug', 'isValidSlug'];
for (const name of names) {
  assert.strictEqual(typeof mod[name], 'function', '缺少导出函数 ' + name);
}

assert.strictEqual(mod.slugify('Hello, World!'), 'hello-world');
assert.strictEqual(mod.slugify('  A  B  '), 'a-b');
assert.strictEqual(mod.slugify('foo_bar/baz'), 'foo-bar-baz');
assert.strictEqual(mod.slugify('---'), '');

assert.strictEqual(mod.truncateSlug('hello-world', 8), 'hello');
assert.strictEqual(mod.truncateSlug('hello-world', 20), 'hello-world');
assert.strictEqual(mod.truncateSlug('hello-world', 6), 'hello');

assert.strictEqual(mod.isValidSlug('hello-world'), true);
assert.strictEqual(mod.isValidSlug('-hello'), false);
assert.strictEqual(mod.isValidSlug('hello--world'), false);
assert.strictEqual(mod.isValidSlug(''), false);

const readme = existsSync('README.md') ? readFileSync('README.md', 'utf8') : '';
assert.ok(readme.trim() !== '', 'README.md 缺失或为空');
for (const name of names) assert.ok(readme.includes(name), 'README.md 未提到 ' + name);
console.log('verify ok');
