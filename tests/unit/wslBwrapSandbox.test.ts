import { test } from 'vitest';
import assert from 'node:assert/strict';
import { WslBwrapSandbox } from '../../src/adapters/sandbox/wslBwrapSandbox.ts';
import { SandboxManager } from '../../src/adapters/sandbox/sandboxManager.ts';
import { ConfigError } from '../../src/config/configError.ts';

test('SEC-01：Windows 路径翻译为 WSL 路径', () => {
  assert.strictEqual(WslBwrapSandbox.toLinuxPath('D:\\work\\proj'), '/mnt/d/work/proj');
  assert.strictEqual(WslBwrapSandbox.toLinuxPath('/home/u/p'), '/home/u/p');
});

test('SEC-01：wrapCommand 进入 bwrap 且禁网', () => {
  const sandbox = new WslBwrapSandbox('D:\\work\\proj');
  const command = sandbox.wrapCommand('echo hi', 'D:\\work\\proj');
  assert.match(command, /wsl\.exe -e bwrap/);
  assert.match(command, /--unshare-net/);
  assert.match(command, /\/mnt\/d\/work\/proj/);
});

test('SEC-01：wsl-bwrap 已接入 profile 构建与配置白名单（Windows 可选真隔离）', () => {
  assert.strictEqual(new SandboxManager('D:\\work').build('wsl-bwrap').name, 'wsl-bwrap');
  assert.doesNotThrow(() => ConfigError.validateConfig({ sandbox: 'wsl-bwrap' }));
});
