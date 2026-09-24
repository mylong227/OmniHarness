import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

/**
 * 带引号参数的用例矩阵（审计 §1.9）。
 *
 * 为什么需要这一组：`cmd /d /s /c` 会按自己的规则重解析命令行，而 Node 拼 Windows 命令行时
 * 也会对 argv 转义一次——两次解析叠加会让命令里的引号错位。此前只在「不带引号的简单命令」上被验证过，
 * 所以缺陷长期没暴露。本组把「引号参数原样到达子进程」逐条钉死：
 *  ① 路径含空格的脚本 + 参数；② 引号内含空格的参数；③ 引号内的 `&`（否则会被当命令分隔符执行）。
 */
describe('shellProcessRunner 带引号参数（审计 §1.9）', () => {
  it('路径含空格的脚本与其参数都能原样到达子进程（旧形态会粘成一个参数）', async () => {
    const base = mkdtempSync(join(tmpdir(), 'omni-quote-'));
    // 目录名与文件名**都含空格**：这是旧形态实测失败的最小复现条件
    const dir = join(base, 'a b');
    mkdirSync(dir);
    const script = join(dir, 'payload script.js');
    const outFile = join(dir, 'argv out.json');
    writeFileSync(
      script,
      'require("node:fs").writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(2)));\n',
    );
    try {
      const outcome = await runner.run(`node "${script}" "${outFile}"`, options());
      assert.strictEqual(
        outcome.exitCode,
        0,
        `带引号路径的命令必须能跑通，stderr=${outcome.stderr.toString('utf8').slice(0, 200)}`,
      );
      const argv = JSON.parse(readFileSync(outFile, 'utf8')) as string[];
      assert.deepStrictEqual(
        argv,
        [outFile],
        '子进程应恰好收到一个参数，且与命令里写的路径逐字相同',
      );
    } finally {
      rmSync(base, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  it('引号内含空格的参数不被拆开', async () => {
    const outcome = await runner.run('echo "one two"', options());
    assert.strictEqual(outcome.exitCode, 0);
    assert.match(outcome.stdout.toString('utf8'), /one two/, '引号内的空格不得被当成分隔符');
  });

  it('引号内的 & 不会被执行成第二条命令（引号语义未被破坏）', async () => {
    // `&` 在 cmd 里是命令分隔符；它出现在引号内时必须保持字面量。
    // 旧形态下引号被吃坏，`&` 会真的分隔命令（第二个命令不存在 ⇒ 报错或退出码异常）。
    const outcome = await runner.run('echo "left&right"', options());
    assert.strictEqual(outcome.exitCode, 0, '引号内的 & 不得变成命令分隔符');
    assert.match(outcome.stdout.toString('utf8'), /left&right/);
  });
});
