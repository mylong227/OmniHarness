import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mod = require('./src/index.js');
const names = ['naturalCompare', 'sortNatural', 'uniqueSorted'];
for (const name of names) {
  assert.strictEqual(typeof mod[name], 'function', '缺少导出函数 ' + name);
}

assert.strictEqual(mod.naturalCompare('a2', 'a10'), -1);
assert.strictEqual(mod.naturalCompare('a10', 'a2'), 1);
assert.strictEqual(mod.naturalCompare('a2', 'a2'), 0);
assert.strictEqual(mod.naturalCompare('a2b', 'a2a'), 1);

assert.deepStrictEqual(mod.sortNatural(['a10', 'a2', 'a1']), ['a1', 'a2', 'a10']);
assert.deepStrictEqual(mod.sortNatural([]), []);

assert.deepStrictEqual(mod.uniqueSorted(['b', 'a2', 'a10', 'a2']), ['a2', 'a10', 'b']);

const readme = existsSync('README.md') ? readFileSync('README.md', 'utf8') : '';
assert.ok(readme.trim() !== '', 'README.md 缺失或为空');
for (const name of names) assert.ok(readme.includes(name), 'README.md 未提到 ' + name);
console.log('verify ok');
