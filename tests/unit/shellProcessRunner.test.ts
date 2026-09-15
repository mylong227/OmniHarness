import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ShellProcessRunner } from '../../src/adapters/tool/shell/shellProcessRunner.js';
import type { ShellRunOptions } from '../../src/adapters/tool/shell/shellProcessRunner.js';

const runner = new ShellProcessRunner();

function options(overrides: Partial<ShellRunOptions> = {}): ShellRunOptions {
  return {
    cwd: process.cwd(),
    env: process.env,
    timeoutMs: 30_000,
    maxBufferBytes: 1024 * 1024,
    ...overrides,
  };
}

describe('shellProcessRunner spawn 执行语义', () => {
  it('成功命令回传 stdout 与退出码 0', async () => {
    const outcome = await runner.run('echo hello-runner', options());
    assert.strictEqual(outcome.exitCode, 0);
    assert.strictEqual(outcome.timedOut, false);
    assert.strictEqual(outcome.overflowed, false);
    assert.match(outcome.stdout.toString('utf8'), /hello-runner/);
  });

  it('非零退出回传真实退出码（不再靠错误文案猜）', async () => {
    const outcome = await runner.run('exit 3', options());
    assert.strictEqual(outcome.exitCode, 3);
    assert.strictEqual(outcome.timedOut, false);
  });

  it('stderr 单独收集，不混入 stdout', async () => {
    const outcome = await runner.run('echo boom 1>&2', options());
    assert.match(outcome.stderr.toString('utf8'), /boom/);
    assert.strictEqual(outcome.stdout.toString('utf8').includes('boom'), false);
  });

  it('超时被显式标记（timedOut）并终止进程', async () => {
    // 慢命令须与 stdin 无关：本 runner 固定 `stdio: ['ignore', ...]`（stdin → NUL），
    // 而 Windows 自带 `timeout.exe` 一旦检测到 stdin 非控制台即报
    // 「不支持输入重定向」并**立即退出**（实测 exit 1 / ~60ms），
    // 会让本用例假红（timedOut 恒 false）。改用 `ping -n 6 127.0.0.1`
    // （不读 stdin、约 5s，且 System32 恒在 PATH）。
    const command = process.platform === 'win32' ? 'ping -n 6 127.0.0.1' : 'sleep 5';
    const outcome = await runner.run(command, options({ timeoutMs: 120 }));
    assert.strictEqual(outcome.timedOut, true);
  });

  it('输出超限被显式标记（overflowed）', async () => {
    const outcome = await runner.run(
      'echo 0123456789012345678901234567890',
      options({ maxBufferBytes: 8 }),
    );
    assert.strictEqual(outcome.overflowed, true);
  });

  it('命令文本作为单个 argv 传递：元字符不被二次拼接（注入面收敛）', async () => {
    const outcome = await runner.run('echo "a b"', options());
    assert.strictEqual(outcome.exitCode, 0);
    assert.match(outcome.stdout.toString('utf8'), /a b/);
  });
});
