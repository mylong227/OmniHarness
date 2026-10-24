// 机械验收器（评测前由 runner 从 verifiers/ 覆盖写入；agent 对 verify.mjs 的改动不算数）。
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mod = require('./src/index.js');
const names = ['retryAsync'];
for (const name of names) {
  assert.strictEqual(typeof mod[name], 'function', '缺少导出函数 ' + name);
}

let calls = 0;
const value = await mod.retryAsync(async () => {
  calls += 1;
  if (calls < 3) throw new Error('boom');
  return 'ok';
}, 5);
assert.strictEqual(value, 'ok');
assert.strictEqual(calls, 3);
let attempts = 0;
let message = '';
try {
  await mod.retryAsync(
    async () => {
      attempts += 1;
      throw new Error('always');
    },
    2,
    1,
  );
} catch (error) {
  message = error.message;
}
assert.strictEqual(attempts, 2);
assert.strictEqual(message, 'always');
let once = 0;
try {
  await mod.retryAsync(async () => {
    once += 1;
    throw new Error('single');
  }, 0);
} catch {
  /* expected */
}
assert.strictEqual(once, 1);

const readme = existsSync('README.md') ? readFileSync('README.md', 'utf8') : '';
assert.ok(readme.trim() !== '', 'README.md 缺失或为空');
for (const name of names) {
  assert.ok(readme.includes(name), 'README.md 未提到 ' + name);
}
console.log('verify ok');
