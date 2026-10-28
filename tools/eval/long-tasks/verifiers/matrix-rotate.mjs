import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mod = require('./src/index.js');
const names = ['rotate', 'transpose', 'spiralOrder'];
for (const name of names) {
  assert.strictEqual(typeof mod[name], 'function', '缺少导出函数 ' + name);
}

assert.deepStrictEqual(
  mod.rotate([
    [1, 2, 3],
    [4, 5, 6],
    [7, 8, 9],
  ]),
  [
    [7, 4, 1],
    [8, 5, 2],
    [9, 6, 3],
  ],
);
assert.deepStrictEqual(mod.rotate([]), []);
assert.deepStrictEqual(
  mod.transpose([
    [1, 2, 3],
    [4, 5, 6],
  ]),
  [
    [1, 4],
    [2, 5],
    [3, 6],
  ],
);
assert.deepStrictEqual(
  mod.spiralOrder([
    [1, 2, 3],
    [4, 5, 6],
    [7, 8, 9],
  ]),
  [1, 2, 3, 6, 9, 8, 7, 4, 5],
);
assert.deepStrictEqual(mod.spiralOrder([]), []);

const readme = existsSync('README.md') ? readFileSync('README.md', 'utf8') : '';
assert.ok(readme.trim() !== '', 'README.md 缺失或为空');
for (const name of names) assert.ok(readme.includes(name), 'README.md 未提到 ' + name);
console.log('verify ok');
