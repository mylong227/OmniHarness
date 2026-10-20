import { test } from 'vitest';
import assert from 'node:assert/strict';
import { WslBwrapSandbox } from '../../src/adapters/sandbox/wslBwrapSandbox.ts';

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
