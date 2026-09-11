import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MacOsSeatbeltSandbox } from '../../src/adapters/sandbox/macOsSeatbeltSandbox.js';
import type { SandboxAction } from '../../src/ports/sandbox.js';

const WS = '/Users/dev/project';

test('macOS seatbelt：非 macOS 平台 fail-closed（绝不谎称已隔离）', () => {
  // 该断言在所有平台都应成立：只要 sandbox-exec 不可用，决策必为拒绝且归类为 os。
  const sb = new MacOsSeatbeltSandbox(WS);
  const writeOutside: SandboxAction = {
    kind: 'file_write',
    target: '/etc/passwd',
  };
  const decision = sb.decide(writeOutside);
  assert.strictEqual(decision.allowed, false, 'sandbox-exec 不可用时必须拒绝，不得声称已隔离');
  assert.strictEqual(decision.category, 'os');
});

test('macOS seatbelt：策略文本含禁网出站 + 仅 workspace 可写（隔离意图可验证）', () => {
  const sb = new MacOsSeatbeltSandbox(WS);
  const profile = sb.profileText(WS);
  assert.match(profile, /deny network-outbound/, '应禁止网络出站');
  assert.match(
    profile,
    new RegExp(`allow file-read\\* file-write\\* \\(subpath "${WS}"\\)`),
    '读写应限于 workspace',
  );
  assert.match(profile, /deny default/, '默认拒绝基线');
});

test('macOS seatbelt：dryRun 构造 sandbox-exec 命令行（含 profile 路径）', () => {
  const sb = new MacOsSeatbeltSandbox(WS);
  const cmd = sb.dryRun('node', ['script.js'], WS, '/tmp/x.sb');
  assert.deepStrictEqual(cmd, ['sandbox-exec', '-f', '/tmp/x.sb', 'node', 'script.js']);
});

test(
  'macOS seatbelt：可在 macOS 真机验证策略执行（其余平台 skip，避免假绿）',
  { skip: process.platform !== 'darwin' },
  async () => {
    const sb = new MacOsSeatbeltSandbox(WS);
    // 仅在真实 macOS 且 sandbox-exec 可用时执行。
    const outside: SandboxAction = { kind: 'file_write', target: '/etc/passwd' };
    const inside: SandboxAction = { kind: 'file_write', target: `${WS}/out.txt` };
    assert.strictEqual(sb.decide(outside).allowed, false, 'workspace 外写入必须被拒');
    assert.strictEqual(sb.decide(inside).allowed, true, 'workspace 内写入应放行');
  },
);
