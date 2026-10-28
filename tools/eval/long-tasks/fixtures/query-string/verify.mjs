import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mod = require('./src/index.js');
const names = ['parseQuery', 'buildQuery', 'getQueryParam'];
for (const name of names) {
  assert.strictEqual(typeof mod[name], 'function', '缺少导出函数 ' + name);
}

assert.deepStrictEqual(mod.parseQuery('a=1&b=hello%20world'), { a: '1', b: 'hello world' });
assert.deepStrictEqual(mod.parseQuery('x=1+2'), { x: '1 2' });
assert.deepStrictEqual(mod.parseQuery(''), {});
assert.deepStrictEqual(mod.parseQuery('flag'), { flag: '' });

assert.strictEqual(mod.buildQuery({ a: '1', b: 'hello world' }), 'a=1&b=hello%20world');
assert.strictEqual(mod.buildQuery({}), '');

assert.strictEqual(mod.getQueryParam('a=1&b=2', 'b'), '2');
assert.strictEqual(mod.getQueryParam('a=1', 'c'), undefined);

const readme = existsSync('README.md') ? readFileSync('README.md', 'utf8') : '';
assert.ok(readme.trim() !== '', 'README.md 缺失或为空');
for (const name of names) assert.ok(readme.includes(name), 'README.md 未提到 ' + name);
console.log('verify ok');
