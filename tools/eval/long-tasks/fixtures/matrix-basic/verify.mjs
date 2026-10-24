// 机械验收器（评测前由 runner 从 verifiers/ 覆盖写入；agent 对 verify.mjs 的改动不算数）。
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mod = require('./src/index.js');
const names = ['transpose', 'multiply', 'identity'];
for (const name of names) {
  assert.strictEqual(typeof mod[name], 'function', '缺少导出函数 ' + name);
}

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
assert.deepStrictEqual(mod.transpose([]), []);
assert.deepStrictEqual(mod.identity(2), [
  [1, 0],
  [0, 1],
]);
assert.deepStrictEqual(mod.identity(0), []);
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
  mod.multiply(mod.identity(2), [
    [1, 2],
    [3, 4],
  ]),
  [
    [1, 2],
    [3, 4],
  ],
);
let threw = false;
try {
  mod.multiply([[1, 2]], [[1, 2]]);
} catch {
  threw = true;
}
assert.strictEqual(threw, true);

const readme = existsSync('README.md') ? readFileSync('README.md', 'utf8') : '';
assert.ok(readme.trim() !== '', 'README.md 缺失或为空');
for (const name of names) {
  assert.ok(readme.includes(name), 'README.md 未提到 ' + name);
}
console.log('verify ok');
