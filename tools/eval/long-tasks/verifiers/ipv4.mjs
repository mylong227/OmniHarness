import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mod = require('./src/index.js');
const names = ['isValidIpv4', 'ipToInt', 'intToIp'];
for (const name of names) {
  assert.strictEqual(typeof mod[name], 'function', '缺少导出函数 ' + name);
}

assert.strictEqual(mod.isValidIpv4('192.168.0.1'), true);
assert.strictEqual(mod.isValidIpv4('0.0.0.0'), true);
assert.strictEqual(mod.isValidIpv4('255.255.255.255'), true);
assert.strictEqual(mod.isValidIpv4('256.1.1.1'), false);
assert.strictEqual(mod.isValidIpv4('1.2.3'), false);
assert.strictEqual(mod.isValidIpv4('01.2.3.4'), false);

assert.strictEqual(mod.ipToInt('0.0.0.1'), 1);
assert.strictEqual(mod.ipToInt('192.168.0.1'), 3232235521);
assert.throws(() => mod.ipToInt('bad'));

assert.strictEqual(mod.intToIp(1), '0.0.0.1');
assert.strictEqual(mod.intToIp(3232235521), '192.168.0.1');
assert.throws(() => mod.intToIp(-1));
assert.throws(() => mod.intToIp(2 ** 32));

const readme = existsSync('README.md') ? readFileSync('README.md', 'utf8') : '';
assert.ok(readme.trim() !== '', 'README.md 缺失或为空');
for (const name of names) assert.ok(readme.includes(name), 'README.md 未提到 ' + name);
console.log('verify ok');
