import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mod = require('./src/index.js');
const names = ['mergeIntervals', 'insertInterval', 'totalCovered'];
for (const name of names) {
  assert.strictEqual(typeof mod[name], 'function', '缺少导出函数 ' + name);
}

assert.deepStrictEqual(
  mod.mergeIntervals([
    [1, 3],
    [2, 6],
    [8, 10],
    [15, 18],
  ]),
  [
    [1, 6],
    [8, 10],
    [15, 18],
  ],
);
assert.deepStrictEqual(
  mod.mergeIntervals([
    [1, 4],
    [4, 5],
  ]),
  [[1, 5]],
);
assert.deepStrictEqual(mod.mergeIntervals([]), []);

assert.deepStrictEqual(
  mod.insertInterval(
    [
      [1, 3],
      [6, 9],
    ],
    [2, 5],
  ),
  [
    [1, 5],
    [6, 9],
  ],
);
assert.deepStrictEqual(mod.insertInterval([], [5, 7]), [[5, 7]]);

assert.strictEqual(
  mod.totalCovered([
    [1, 3],
    [5, 7],
  ]),
  4,
);
assert.strictEqual(
  mod.totalCovered([
    [1, 5],
    [2, 3],
  ]),
  4,
);

const readme = existsSync('README.md') ? readFileSync('README.md', 'utf8') : '';
assert.ok(readme.trim() !== '', 'README.md 缺失或为空');
for (const name of names) assert.ok(readme.includes(name), 'README.md 未提到 ' + name);
console.log('verify ok');
