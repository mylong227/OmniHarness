// 机械验收器（评测前由 runner 从 verifiers/ 覆盖写入；agent 对 verify.mjs 的改动不算数）。
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mod = require('./src/index.js');
const names = ['createEmitter'];
for (const name of names) {
  assert.strictEqual(typeof mod[name], 'function', '缺少导出函数 ' + name);
}

const emitter = mod.createEmitter();
const seen = [];
const handler = (value) => seen.push('a' + value);
const unsubscribe = emitter.on('x', handler);
emitter.on('x', (value) => seen.push('b' + value));
emitter.emit('x', 1);
assert.deepStrictEqual(seen, ['a1', 'b1']);
unsubscribe();
emitter.emit('x', 2);
assert.deepStrictEqual(seen, ['a1', 'b1', 'b2']);
const onceSeen = [];
emitter.once('y', (value) => onceSeen.push(value));
emitter.emit('y', 1);
emitter.emit('y', 2);
assert.deepStrictEqual(onceSeen, [1]);

const readme = existsSync('README.md') ? readFileSync('README.md', 'utf8') : '';
assert.ok(readme.trim() !== '', 'README.md 缺失或为空');
for (const name of names) {
  assert.ok(readme.includes(name), 'README.md 未提到 ' + name);
}
console.log('verify ok');
