/**
 * `shell` 的**「DLL 初始化回退」诚实上报**判据（2026-10-11）。
 *
 * ## 它拦的是什么
 *
 * 2026-10-07 真实事故：Windows 受限令牌沙箱下，带 `CREATE_NO_WINDOW` 的首次启动死在 DLL 初始化
 * （`0xC0000142`，连用户代码都没进），运行器改用「继承控制台」重跑一次 ⇒ **命令实际跑过两次**。
 * 若不说明，调用方会以为它只跑了一次（在"命令有副作用"的心智模型下这是危险的误解）。
 * 现行为：`outcome.consoleFallback === true` ⇒ 落一条 warn + 在输出末尾追加一句人类可读说明。
 *
 * ## 判据怎么构造
 *
 * 该分支只在特定 Windows 沙箱条件下出现，正常环境不可达 ⇒ 用 `ShellToolOptions.runner` 注入替身
 * （这就是加那个缝的理由）。三条：① `consoleFallback:true` ⇒ 输出带说明 + 有 warn 日志；
 * ② **反面对照**：`undefined`/`false` ⇒ 两者都不得出现（否则这句话会退化成每次都说的噪声）；
 * ③ 说明必须与退出码/输出**并存**（不是替换掉真实输出）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ShellTool } from '../../src/adapters/tool/shell/shellTool.js';
import type { ShellRunOutcome } from '../../src/adapters/tool/shell/shellProcessRunner.js';
import type { ShellToolOptions } from '../../src/adapters/tool/shell/shellTool.js';
import type { ToolContext } from '../../src/ports/tool/tool.js';

/** 被测命令（不真跑：执行器是替身）。 */
const CALL = { id: 'c-shell', name: 'shell', arguments: { command: 'echo hi' } };

/** 工具上下文。 */
const CTX: ToolContext = { sessionId: 's-shell', workspaceRoot: process.cwd() };

/**
 * 造一个返回固定结果的执行器替身。
 * @param consoleFallback 是否模拟"首次启动死在 DLL 初始化、第二次成功"。
 * @returns 满足 `ShellToolOptions.runner` 的替身（**始终**返回替身；`consoleFallback` 用可选字段表达）。
 */
function runnerReturning(
  consoleFallback: boolean | undefined,
): NonNullable<ShellToolOptions['runner']> {
  return {
    run: () =>
      Promise.resolve({
        stdout: Buffer.from('hi\n', 'utf8'),
        stderr: Buffer.alloc(0),
        exitCode: 0,
        signal: null,
        timedOut: false,
        overflowed: false,
        aborted: false,
        ...(consoleFallback === undefined ? {} : { consoleFallback }),
      } satisfies ShellRunOutcome),
  };
}

/**
 * 采集 stderr 上的结构化日志行（沿用本仓既有夹具的接管方式）。
 * @param fn 断言体。
 * @returns 采集到的原始行。
 */
async function captureStderr(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    lines.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof process.stderr.write;
  try {
    await fn();
    return lines;
  } finally {
    process.stderr.write = original;
  }
}

test('① consoleFallback=true ⇒ 输出带"跑过两次"的说明，且落 warn 日志', async () => {
  const tool = new ShellTool({ runner: runnerReturning(true) });
  let output = '';
  const lines = await captureStderr(async () => {
    const result = await tool.handle(CALL, CTX);
    assert.strictEqual(result.ok, true);
    output = result.output ?? '';
  });
  assert.match(
    output,
    /首次启动在 DLL 初始化阶段失败[\s\S]*重新执行/,
    `输出必须说明"命令实际启动了两次"，实为：${output}`,
  );
  // 真实输出必须**并存**（说明不是拿来替换命令输出的）
  assert.match(output, /hi/, '原始 stdout 必须仍在输出里');
  const warn = lines.find((line) => line.includes('shell.consoleFallback'));
  assert.ok(warn !== undefined, `必须落一条 shell.consoleFallback warn，实采：${lines.join('')}`);
  assert.match(warn, /DLL/, 'warn 里应写明原因（DLL 初始化失败）');
});

test('② 反面对照：consoleFallback 缺省/为 false ⇒ 既无说明也无 warn', async () => {
  for (const value of [undefined, false] as const) {
    const tool = new ShellTool({ runner: runnerReturning(value) });
    let output = '';
    const lines = await captureStderr(async () => {
      const result = await tool.handle(CALL, CTX);
      output = result.output ?? '';
    });
    assert.ok(
      !output.includes('DLL 初始化'),
      `consoleFallback=${String(value)} 时不得出现该说明（否则退化成噪声）：${output}`,
    );
    assert.ok(
      !lines.some((line) => line.includes('shell.consoleFallback')),
      `consoleFallback=${String(value)} 时不得落该 warn`,
    );
  }
});
