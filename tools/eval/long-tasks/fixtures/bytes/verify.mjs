import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mod = require('./src/index.js');
const names = ['formatBytes', 'parseBytes', 'isValidBytes'];
for (const name of names) {
  assert.strictEqual(typeof mod[name], 'function', '缺少导出函数 ' + name);
}

assert.strictEqual(mod.formatBytes(0), '0 B');
assert.strictEqual(mod.formatBytes(512), '512 B');
assert.strictEqual(mod.formatBytes(1024), '1.0 KB');
assert.strictEqual(mod.formatBytes(1536), '1.5 KB');
assert.strictEqual(mod.formatBytes(1024 * 1024), '1.0 MB');

assert.strictEqual(mod.parseBytes('1.5 KB'), 1536);
assert.strictEqual(mod.parseBytes('512 B'), 512);
assert.strictEqual(mod.parseBytes('2 MB'), 2 * 1024 * 1024);
assert.throws(() => mod.parseBytes('abc'));

assert.strictEqual(mod.isValidBytes('1.5 KB'), true);
assert.strictEqual(mod.isValidBytes('512'), false);
assert.strictEqual(mod.isValidBytes('abc'), false);

const readme = existsSync('README.md') ? readFileSync('README.md', 'utf8') : '';
assert.ok(readme.trim() !== '', 'README.md 缺失或为空');
for (const name of names) assert.ok(readme.includes(name), 'README.md 未提到 ' + name);
console.log('verify ok');
