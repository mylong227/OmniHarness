import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mod = require('./src/index.js');
const names = ['wrapText', 'truncateMiddle', 'countWords'];
for (const name of names) {
  assert.strictEqual(typeof mod[name], 'function', '缺少导出函数 ' + name);
}

assert.deepStrictEqual(mod.wrapText('the quick brown fox', 10), ['the quick', 'brown fox']);
assert.deepStrictEqual(mod.wrapText('a  b   c', 3), ['a b', 'c']);
assert.deepStrictEqual(mod.wrapText('', 5), []);

assert.strictEqual(mod.truncateMiddle('abcdefghij', 7), 'abc…hij');
assert.strictEqual(mod.truncateMiddle('abc', 10), 'abc');
assert.strictEqual(mod.truncateMiddle('abcdef', 4), 'ab…f');

assert.strictEqual(mod.countWords('hello world 你好'), 3);
assert.strictEqual(mod.countWords('   '), 0);

const readme = existsSync('README.md') ? readFileSync('README.md', 'utf8') : '';
assert.ok(readme.trim() !== '', 'README.md 缺失或为空');
for (const name of names) assert.ok(readme.includes(name), 'README.md 未提到 ' + name);
console.log('verify ok');
