import { test } from 'vitest';
import assert from 'node:assert/strict';
import { LinuxBwrapSandbox } from '../../src/adapters/sandbox/linuxBwrapSandbox.ts';
import { MacOsSeatbeltSandbox } from '../../src/adapters/sandbox/macosSeatbeltSandbox.ts';

const WORKSPACE = '/home/user/workspace';

test('LinuxBwrapSandbox: bwrap 不可用时 check 返回 allowed:false (fail-closed)', async () => {
  // 在 CI/Windows 下 bwrap 通常不存在，验证绝不放行。
  const sb = new LinuxBwrapSandbox(WORKSPACE);
  const decision = await sb.check({ kind: 'command', target: 'ls' });
  if (!decision.allowed) {
    assert.strictEqual(decision.category, 'os');
    assert.match(decision.reason ?? '', /bwrap/);
  } else {
    // bwrap 可用：命令放行必须是“无拒绝类别”的允许，而不是任意 true。
    assert.strictEqual(decision.category, undefined);
  }
});

test('LinuxBwrapSandbox: wrapCommand 把命令包进 /bin/sh -c 并转义单引号', () => {
  const sb = new LinuxBwrapSandbox(WORKSPACE);
  const wrapped = sb.wrapCommand("echo 'x' && echo ok", WORKSPACE);
  assert.match(wrapped, /^'bwrap' /u);
  assert.match(wrapped, /--unshare-net/u);
  assert.match(wrapped, /'\/bin\/sh' '-c'/u);
  assert.ok(wrapped.includes(`'echo '\\''x'\\'' && echo ok'`), wrapped);
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
  const decision = await sb.check({ kind: 'command', target: 'ls' });
  if (process.platform !== 'darwin') {
    assert.strictEqual(decision.allowed, false);
    assert.strictEqual(decision.category, 'os');
    assert.match(decision.reason ?? '', /sandbox-exec/);
  } else {
    // macOS 可用：允许决策不得携带拒绝类别（true 之外的契约）。
    assert.strictEqual(decision.category, undefined);
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
