import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mod = require('./src/index.js');
const names = ['multiply', 'identity', 'isSquare'];
for (const name of names) {
  assert.strictEqual(typeof mod[name], 'function', '缺少导出函数 ' + name);
}

assert.deepStrictEqual(
  mod.multiply(
    [
      [1, 2],
      [3, 4],
    ],
    [
      [5, 6],
      [7, 8],
    ],
  ),
  [
    [19, 22],
    [43, 50],
  ],
);
assert.deepStrictEqual(
  mod.multiply(
    [
      [1, 2, 3],
      [4, 5, 6],
    ],
    [[7], [8], [9]],
  ),
  [[50], [122]],
);
assert.throws(() => mod.multiply([[1, 2]], [[1, 2]]));

assert.deepStrictEqual(mod.identity(2), [
  [1, 0],
  [0, 1],
]);
assert.throws(() => mod.identity(0));

assert.strictEqual(
  mod.isSquare([
    [1, 2],
    [3, 4],
  ]),
  true,
);
assert.strictEqual(
  mod.isSquare([
    [1, 2, 3],
    [4, 5, 6],
  ]),
  false,
);
assert.strictEqual(mod.isSquare([]), false);

const readme = existsSync('README.md') ? readFileSync('README.md', 'utf8') : '';
assert.ok(readme.trim() !== '', 'README.md 缺失或为空');
for (const name of names) assert.ok(readme.includes(name), 'README.md 未提到 ' + name);
console.log('verify ok');
