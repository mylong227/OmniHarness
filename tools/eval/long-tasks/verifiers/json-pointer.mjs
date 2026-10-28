import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mod = require('./src/index.js');
const names = ['escapePointer', 'getPointer', 'setPointer'];
for (const name of names) {
  assert.strictEqual(typeof mod[name], 'function', '缺少导出函数 ' + name);
}

assert.strictEqual(mod.escapePointer('a/b~c'), 'a~1b~0c');
assert.strictEqual(mod.escapePointer('plain'), 'plain');

const source = { a: { b: [{ c: 1 }] } };
assert.strictEqual(mod.getPointer(source, '/a/b/0/c'), 1);
assert.strictEqual(mod.getPointer(source, '/a/missing'), undefined);
assert.strictEqual(mod.getPointer(source, ''), source);

const updated = mod.setPointer(source, '/a/b/0/c', 2);
assert.strictEqual(mod.getPointer(updated, '/a/b/0/c'), 2);
assert.strictEqual(mod.getPointer(source, '/a/b/0/c'), 1, 'setPointer 不得修改原对象');
assert.throws(() => mod.getPointer(source, 'a/b'));

const readme = existsSync('README.md') ? readFileSync('README.md', 'utf8') : '';
assert.ok(readme.trim() !== '', 'README.md 缺失或为空');
for (const name of names) assert.ok(readme.includes(name), 'README.md 未提到 ' + name);
console.log('verify ok');
