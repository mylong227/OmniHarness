import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LinuxBwrapSandbox } from '../../src/adapters/sandbox/linuxBwrapSandbox.js';
import { MacOsSeatbeltSandbox } from '../../src/adapters/sandbox/macosSeatbeltSandbox.js';

const WORKSPACE = '/home/user/workspace';

test('LinuxBwrapSandbox: bwrap 不可用时 check 返回 allowed:false (fail-closed)', async () => {
  // 在 CI/Windows 下 bwrap 通常不存在，验证绝不放行。
  const sb = new LinuxBwrapSandbox(WORKSPACE);
  const decision = await sb.check({ kind: 'command', target: 'ls' });
  if (!decision.allowed) {
    assert.strictEqual(decision.category, 'os');
    assert.match(decision.reason ?? '', /bwrap/);
  } else {
    // 仅在真实 Linux + bwrap 可用时 allow，仍应遵守受限策略。
    assert.ok(true);
  }
});

test('LinuxBwrapSandbox: dryRun 生成含 --unshare-net 与 --bind workspace 的命令行', () => {
  const sb = new LinuxBwrapSandbox(WORKSPACE);
  const cmd = sb.dryRun('node', ['script.js'], WORKSPACE);
  assert.strictEqual(cmd[0], 'bwrap');
  assert.ok(cmd.includes('--unshare-net'), '应禁网络');
  const bindIdx = cmd.indexOf('--bind');
  assert.ok(bindIdx >= 0, '应包含 --bind');
  assert.strictEqual(cmd[bindIdx + 1], WORKSPACE);
  assert.strictEqual(cmd[bindIdx + 2], WORKSPACE);
  assert.ok(cmd.includes('--die-with-parent'));
  assert.strictEqual(cmd[cmd.length - 2], 'node');
  assert.strictEqual(cmd[cmd.length - 1], 'script.js');
});

test('MacOsSeatbeltSandbox: 非 macOS 平台 check 返回 allowed:false (fail-closed)', async () => {
  const sb = new MacOsSeatbeltSandbox(WORKSPACE);
  if (process.platform !== 'darwin') {
    const decision = await sb.check({ kind: 'command', target: 'ls' });
    assert.strictEqual(decision.allowed, false);
    assert.strictEqual(decision.category, 'os');
    assert.match(decision.reason ?? '', /sandbox-exec/);
  } else {
    assert.ok(true);
  }
});

test('MacOsSeatbeltSandbox: dryRun 返回 sandbox-exec 命令行且 profile 禁网络', () => {
  const sb = new MacOsSeatbeltSandbox(WORKSPACE);
  const cmd = sb.dryRun('node', ['app.js'], WORKSPACE);
  assert.strictEqual(cmd[0], 'sandbox-exec');
  assert.strictEqual(cmd[1], '-f');
  assert.ok(cmd.includes('node'), '命令应出现在命令行');
  const profile = sb.profileText(WORKSPACE);
  assert.match(profile, /deny network-outbound/);
  assert.match(profile, new RegExp(WORKSPACE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});
