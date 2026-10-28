import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mod = require('./src/index.js');
const names = ['normalizeHex', 'hexToRgb', 'rgbToHex'];
for (const name of names) {
  assert.strictEqual(typeof mod[name], 'function', '缺少导出函数 ' + name);
}

assert.strictEqual(mod.normalizeHex('#abc'), '#aabbcc');
assert.strictEqual(mod.normalizeHex('ABCDEF'), '#abcdef');
assert.strictEqual(mod.normalizeHex('#12345'), null);

assert.deepStrictEqual(mod.hexToRgb('#ff0000'), { r: 255, g: 0, b: 0 });
assert.deepStrictEqual(mod.hexToRgb('#0f0'), { r: 0, g: 255, b: 0 });
assert.throws(() => mod.hexToRgb('nope'));

assert.strictEqual(mod.rgbToHex(255, 0, 0), '#ff0000');
assert.strictEqual(mod.rgbToHex(0, 255, 0), '#00ff00');
assert.throws(() => mod.rgbToHex(256, 0, 0));

const readme = existsSync('README.md') ? readFileSync('README.md', 'utf8') : '';
assert.ok(readme.trim() !== '', 'README.md 缺失或为空');
for (const name of names) assert.ok(readme.includes(name), 'README.md 未提到 ' + name);
console.log('verify ok');
