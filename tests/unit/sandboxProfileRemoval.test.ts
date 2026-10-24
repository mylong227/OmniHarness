import { test } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SandboxManager } from '../../src/adapters/sandbox/sandboxManager.ts';
import { SandboxCapabilityTable } from '../../src/adapters/sandbox/sandboxCapabilityTable.ts';
import { ConfigError } from '../../src/config/configError.ts';
import { SANDBOX_PROFILES } from '../../src/cli/cliEnums.ts';
import type { SandboxProfile } from '../../src/ports/runtime/sandbox/sandboxProfile.ts';

/**
 * 移除第三方 Windows ACL 后端后的**回归护栏**（2026-10-24）。
 *
 * 背景：该后端是唯一把第三方 harness 依赖带进运行时的路径，已按用户要求整体删除。
 * 本判据锁住四件事，防止日后有人「顺手」把 profile/依赖/能力表加回来：
 * ① 枚举里不再有 `windows-acl*`；② 配置校验拒绝该值；③ 未注册的 profile fail-closed；
 * ④ 能力表不谎称 Windows 原生写隔离；⑤ 源码与依赖里不再有该实现。
 */
test('① 沙箱枚举不再包含已删除的 windows-acl 档', () => {
  assert.ok(!(SANDBOX_PROFILES as readonly string[]).includes('windows-acl'));
  assert.ok(!(SANDBOX_PROFILES as readonly string[]).includes('windows-acl-readonly'));
});

test('② 配置校验拒绝已删除的 windows-acl 档（fail-closed）', () => {
  const legacy = 'windows-acl' as unknown as SandboxProfile;
  const legacyReadonly = 'windows-acl-readonly' as unknown as SandboxProfile;
  assert.throws(() => ConfigError.validateConfig({ sandbox: legacy }));
  assert.throws(() => ConfigError.validateConfig({ sandbox: legacyReadonly }));
});

test('③ 未注册 profile 走 UnsupportedSandbox 并拒绝执行', async () => {
  const sandbox = new SandboxManager(process.cwd()).build(
    'windows-acl' as unknown as SandboxProfile,
  );
  const decision = await sandbox.check({ kind: 'command', target: 'echo hi' });
  assert.strictEqual(decision.allowed, false, '未知 profile 必须 fail-closed，不得回落直通');
});

test('④ 能力表如实区分原生写隔离与 TS 策略层', () => {
  const entries = SandboxCapabilityTable.describe(process.cwd());
  assert.ok(!entries.some((e) => String(e.profile).startsWith('windows-acl')));
  const text = entries.map((e) => `${e.basis} ${e.actionable}`).join('\n');
  assert.ok(!/windows-acl|Windows ACL 写隔离已启用/u.test(text), '能力表不得声称已恢复已删除后端');
  const restricted = entries.find((e) => e.profile === 'restricted');
  assert.ok(restricted !== undefined);
  assert.match(restricted.basis, /写隔离|策略层/u);
});

test('⑤ 源码与依赖中不再有 windows-acl 实现或第三方沙箱依赖', () => {
  assert.strictEqual(
    existsSync(join(process.cwd(), 'src', 'adapters', 'sandbox', 'windowsAclSandbox.ts')),
    false,
    '已被删除的后端文件不得复活',
  );
  const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
    optionalDependencies?: Record<string, string>;
    dependencies?: Record<string, string>;
  };
  const all = { ...pkg.dependencies, ...pkg.optionalDependencies };
  assert.ok(!Object.keys(all).some((k) => k.startsWith('@deepseek-ai/')), '不得恢复第三方沙箱依赖');
});
