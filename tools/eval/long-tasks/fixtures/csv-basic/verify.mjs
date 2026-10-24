// 机械验收器（评测前由 runner 从 verifiers/ 覆盖写入；agent 对 verify.mjs 的改动不算数）。
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mod = require('./src/index.js');
const names = ['parseCsvLine', 'escapeCsvField', 'toCsvLine'];
for (const name of names) {
  assert.strictEqual(typeof mod[name], 'function', '缺少导出函数 ' + name);
}

assert.deepStrictEqual(mod.parseCsvLine('a,b,c'), ['a', 'b', 'c']);
assert.deepStrictEqual(mod.parseCsvLine('a,"b,c",d'), ['a', 'b,c', 'd']);
assert.deepStrictEqual(mod.parseCsvLine('"he said ""hi""",1'), ['he said "hi"', '1']);
assert.strictEqual(mod.escapeCsvField('a,b'), '"a,b"');
assert.strictEqual(mod.escapeCsvField('plain'), 'plain');
assert.strictEqual(mod.escapeCsvField(undefined), '');
assert.strictEqual(mod.toCsvLine(['a,b', 'c']), '"a,b",c');

const readme = existsSync('README.md') ? readFileSync('README.md', 'utf8') : '';
assert.ok(readme.trim() !== '', 'README.md 缺失或为空');
for (const name of names) {
  assert.ok(readme.includes(name), 'README.md 未提到 ' + name);
}
console.log('verify ok');
