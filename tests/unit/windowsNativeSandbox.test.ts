import { test } from 'vitest';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WindowsNativeSandbox } from '../../src/adapters/sandbox/windowsNativeSandbox.ts';
import { SandboxManager } from '../../src/adapters/sandbox/sandboxManager.ts';
import { ShellTool } from '../../src/adapters/tool/shell/shellTool.ts';
import { OmniCliLocator } from '../../src/native/omniCliLocator.ts';

/**
 * `windows-native` profile 的判据：
 * ① 策略面与 restricted 同源（curl 仍被拒）；
 * ② 执行面把命令交给 `omni-cli sandbox run --workspace`，命令文本落临时文件；
 * ③ 真机端到端：工作区可写、越界写被内核拒绝（找不到二进制时如实跳过）。
 */
test('windows-native：策略面复用 restricted（网络外联仍拒绝）', async () => {
  const sandbox = new WindowsNativeSandbox(process.cwd());
  const decision = await sandbox.check({ kind: 'command', target: 'curl https://example.com' });
  assert.strictEqual(decision.allowed, false);
  assert.strictEqual(sandbox.name, 'windows-native');
});

test('windows-native：SandboxManager 已注册该 profile', () => {
  const sandbox = new SandboxManager(process.cwd()).build('windows-native');
  assert.strictEqual(sandbox.name, 'windows-native');
});

test('windows-native：包装命令指向原生启动器并把命令写入命令文件', () => {
  if (process.platform !== 'win32') return;
  if (OmniCliLocator.tryLocate() === undefined) return;
  const root = mkdtempSync(join(tmpdir(), 'omni-wn-'));
  try {
    const sandbox = new WindowsNativeSandbox(root);
    const wrapped = sandbox.wrapCommand('echo hi', root);
    assert.match(wrapped, /sandbox run/u);
    assert.match(wrapped, /--workspace/u);
    assert.match(wrapped, /--command-file/u);
    const match = /--command-file "([^"]+)"/u.exec(wrapped);
    assert.ok(match !== null, '包装命令必须带 --command-file 路径');
    assert.strictEqual(readFileSync(match[1]!, 'utf8'), 'echo hi');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('windows-native：ShellTool 经 commandWrapper 走原生启动器（默认 TS 工具链接线）', async () => {
  if (process.platform !== 'win32') return;
  if (OmniCliLocator.tryLocate() === undefined) return;
  const root = mkdtempSync(join(tmpdir(), 'omni-wn-shell-'));
  try {
    const sandbox = new WindowsNativeSandbox(root);
    const tool = new ShellTool({
      commandWrapper: (command, cwd) => sandbox.wrapCommand(command, cwd),
    });
    const result = await tool.handle(
      { id: 'c1', name: 'shell', arguments: { command: 'echo native-ok' } },
      { sessionId: 's1', workspaceRoot: root },
    );
    assert.strictEqual(result.ok, true, result.error);
    assert.match(result.output ?? '', /native-ok/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 180_000);

test('windows-native：真机端到端写隔离（区内写成功、区外写被拒）', () => {
  if (process.platform !== 'win32') return;
  if (OmniCliLocator.tryLocate() === undefined) return;
  const root = mkdtempSync(join(tmpdir(), 'omni-wn-e2e-'));
  const outside = join(tmpdir(), `omni-wn-out-${Date.now()}.txt`);
  try {
    const sandbox = new WindowsNativeSandbox(root);
    const wrapped = sandbox.wrapCommand(`echo in> inside.txt & echo out> "${outside}"`, root);
    let failed = false;
    try {
      execSync(wrapped, { cwd: root, stdio: 'ignore', timeout: 120_000 });
    } catch {
      failed = true;
    }
    assert.strictEqual(existsSync(join(root, 'inside.txt')), true, '工作区内写入必须成功');
    assert.strictEqual(existsSync(outside), false, '工作区外写入必须被内核拒绝');
    assert.strictEqual(failed, true, '越界写入应让命令非零退出');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { force: true });
  }
}, 180_000);
