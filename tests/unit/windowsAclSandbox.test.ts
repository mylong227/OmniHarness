import { test } from 'vitest';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WindowsAclSandbox } from '../../src/adapters/sandbox/windowsAclSandbox.ts';
import { SandboxManager } from '../../src/adapters/sandbox/sandboxManager.ts';
import { ConfigError } from '../../src/config/configError.ts';

test('Windows ACL：profile 已接入 SandboxManager 与配置白名单', () => {
  assert.strictEqual(new SandboxManager(process.cwd()).build('windows-acl').name, 'windows-acl');
  assert.strictEqual(
    new SandboxManager(process.cwd()).build('windows-acl-readonly').name,
    'windows-acl-readonly',
  );
  assert.doesNotThrow(() => ConfigError.validateConfig({ sandbox: 'windows-acl' }));
});

/**
 * 真机判据：Windows ACL 后端必须实际启动受限进程，并且写隔离真的生效。
 * 非 Windows 直接跳过（后端自身 fail-closed）。
 */
test('Windows ACL：工作区内可写、工作区外写入被 OS 拒绝（2026-10-21）', () => {
  if (process.platform !== 'win32') {
    return;
  }
  const root = mkdtempSync(join(tmpdir(), 'omni-winacl-'));
  const outside = join(tmpdir(), `omni-winacl-outside-${Date.now()}.txt`);
  try {
    const sandbox = new WindowsAclSandbox(root, 'workspace-write');
    const wrapped = sandbox.wrapCommand(
      `echo ACL_INSIDE_OK > inside.txt & echo NOPE > "${outside}"`,
      root,
    );
    let failed = false;
    try {
      execSync(wrapped, { cwd: root, encoding: 'utf8', timeout: 120_000 });
    } catch {
      failed = true;
    }
    assert.strictEqual(existsSync(join(root, 'inside.txt')), true, '工作区内写入必须成功');
    assert.strictEqual(existsSync(outside), false, '工作区外写入必须被 OS 拒绝');
    assert.strictEqual(failed, true, '越界写入应让命令以非零码结束');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { force: true });
  }
}, 180_000);

test('Windows ACL：read-only 下工作区写入也被拒绝', () => {
  if (process.platform !== 'win32') {
    return;
  }
  const root = mkdtempSync(join(tmpdir(), 'omni-winacl-ro-'));
  try {
    const sandbox = new WindowsAclSandbox(root, 'read-only');
    const wrapped = sandbox.wrapCommand('echo NOPE > should-not-exist.txt', root);
    let failed = false;
    try {
      execSync(wrapped, { cwd: root, encoding: 'utf8', timeout: 120_000 });
    } catch {
      failed = true;
    }
    assert.strictEqual(failed, true, 'read-only 下写入必须失败');
    assert.strictEqual(existsSync(join(root, 'should-not-exist.txt')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 180_000);
