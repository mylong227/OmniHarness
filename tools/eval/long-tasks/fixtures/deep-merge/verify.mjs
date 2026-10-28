import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mod = require('./src/index.js');
const names = ['mergeDeep', 'getPath', 'setPath'];
for (const name of names) {
  assert.strictEqual(typeof mod[name], 'function', '缺少导出函数 ' + name);
}

assert.deepStrictEqual(
  mod.mergeDeep({ a: 1, nested: { x: 1, y: 2 } }, { b: 2, nested: { y: 3, z: 4 } }),
  { a: 1, b: 2, nested: { x: 1, y: 3, z: 4 } },
);
assert.deepStrictEqual(mod.mergeDeep({ a: [1, 2] }, { a: [3] }), { a: [3] });

const source = { a: { b: [{ c: 42 }] } };
assert.strictEqual(mod.getPath(source, 'a.b.0.c'), 42);
assert.strictEqual(mod.getPath(source, 'a.missing'), undefined);

const updated = mod.setPath(source, 'a.b.0.c', 7);
assert.strictEqual(mod.getPath(updated, 'a.b.0.c'), 7);
assert.strictEqual(mod.getPath(source, 'a.b.0.c'), 42, 'setPath 不得修改原对象');

const readme = existsSync('README.md') ? readFileSync('README.md', 'utf8') : '';
assert.ok(readme.trim() !== '', 'README.md 缺失或为空');
for (const name of names) assert.ok(readme.includes(name), 'README.md 未提到 ' + name);
console.log('verify ok');
