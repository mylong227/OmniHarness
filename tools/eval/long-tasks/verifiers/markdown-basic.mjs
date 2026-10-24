// 机械验收器（评测前由 runner 从 verifiers/ 覆盖写入；agent 对 verify.mjs 的改动不算数）。
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mod = require('./src/index.js');
const names = ['stripCodeFences', 'extractHeadings', 'buildToc'];
for (const name of names) {
  assert.strictEqual(typeof mod[name], 'function', '缺少导出函数 ' + name);
}

assert.strictEqual(mod.stripCodeFences('a\n```\nx\n```\nb'), 'a\n\nb');
assert.deepStrictEqual(mod.extractHeadings('# A\n\ntext\n## B\n```\n# not\n```\n### C'), [
  { level: 1, text: 'A' },
  { level: 2, text: 'B' },
  { level: 3, text: 'C' },
]);
assert.strictEqual(
  mod.buildToc([
    { level: 1, text: 'A' },
    { level: 3, text: 'C' },
  ]),
  '- A\n    - C',
);
assert.strictEqual(mod.buildToc([]), '');

const readme = existsSync('README.md') ? readFileSync('README.md', 'utf8') : '';
assert.ok(readme.trim() !== '', 'README.md 缺失或为空');
for (const name of names) {
  assert.ok(readme.includes(name), 'README.md 未提到 ' + name);
}
console.log('verify ok');
