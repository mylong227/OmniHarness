/**
 * shell_interactive 单测（任务①-b/c）：全程不真开 TTY、不真 spawn。
 *
 * 覆盖四件关键事：
 * 1. 无 TTY 时 **fail-closed**：返回可执行原因，且执行器一次都没被调用（不静默退化成管道）；
 * 2. TTY 时按分级形态构造 argv（有 script 走包装、无 script 走 inherit 直通）；
 * 3. 退出码/信号/超时**如实回传**（不把失败伪装成成功）；
 * 4. 与 shell 工具同口径的校验与裁决（空命令/超长/策略/裁决器）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ShellInteractiveTool } from '../../src/adapters/tool/shell/shellInteractiveTool.js';
import { ShellCommandPolicy } from '../../src/adapters/tool/shell/shellCommandPolicy.js';
import {
  ShellInteractiveExecutor,
  type InteractiveRunOptions,
  type InteractiveRunOutcome,
} from '../../src/adapters/tool/shell/shellInteractiveExecutor.js';
import type { PtyProbe } from '../../src/adapters/tool/shell/ptyCapability.js';
import type { ToolCall, ToolContext } from '../../src/ports/tool/tool.js';

/** 记录调用入参的假执行器（不真 spawn，且可编排退出状态）。 */
class FakeExecutor extends ShellInteractiveExecutor {
  /** 已收到的调用参数（按序）。 */
  public readonly calls: Array<{
    readonly bin: string;
    readonly args: readonly string[];
    readonly options: InteractiveRunOptions;
  }> = [];

  /** 下一次调用要返回的结果。 */
  public outcome: InteractiveRunOutcome = { exitCode: 0, signal: null, timedOut: false };

  /** 下一次调用要抛的错误。 */
  public failWith: Error | undefined;

  /**
   * 记录一次执行请求并按预设结果返回（不 spawn，任何平台可跑）。
   *
   * @param bin 可执行文件。
   * @param args 参数。
   * @param options 执行选项。
   * @returns 预设的执行结果。
   */
  public override async run(
    bin: string,
    args: readonly string[],
    options: InteractiveRunOptions,
  ): Promise<InteractiveRunOutcome> {
    this.calls.push({ bin, args, options });
    if (this.failWith !== undefined) {
      throw this.failWith;
    }
    return this.outcome;
  }
}

const call = (args: Record<string, unknown>): ToolCall => ({
  id: 'c1',
  name: 'shell_interactive',
  arguments: args,
});
const ctx: ToolContext = { sessionId: 's1', workspaceRoot: process.cwd() };

/** 无 TTY 且无 script 的探测输入（确定性 fail-closed）。 */
const NO_TTY: PtyProbe = { platform: 'win32', hasTty: false, scriptAvailable: false };

/** 有 TTY 的探测输入（直通形态）。 */
const TTY_INHERIT: PtyProbe = { platform: 'win32', hasTty: true, scriptAvailable: false };

/** 有 script 的探测输入（真 PTY 包装形态）。 */
const SCRIPT_TTY: PtyProbe = { platform: 'linux', hasTty: true, scriptAvailable: true };

describe('shell_interactive 分级与 fail-closed', () => {
  it('无 TTY 且无 script：fail-closed，且执行器一次都不被调用', async () => {
    const executor = new FakeExecutor();
    const tool = new ShellInteractiveTool({ probe: NO_TTY, executor });
    const result = await tool.handle(call({ command: 'vim x.txt' }), ctx);
    assert.strictEqual(result.ok, false, '无终端必须失败，不得静默走管道');
    assert.match(result.error ?? '', /fail-closed/);
    assert.match(result.error ?? '', /不静默退化为管道/);
    assert.deepStrictEqual(executor.calls, [], 'fail-closed 路径不得触达执行器');
  });

  it('有能力时：工具自述的能力报告与实际分支一致', () => {
    const plain = new ShellInteractiveTool({ probe: NO_TTY, executor: new FakeExecutor() });
    assert.strictEqual(plain.capability().mode, 'unavailable');
    const tty = new ShellInteractiveTool({ probe: TTY_INHERIT, executor: new FakeExecutor() });
    assert.strictEqual(tty.capability().mode, 'inherit');
    const script = new ShellInteractiveTool({ probe: SCRIPT_TTY, executor: new FakeExecutor() });
    assert.strictEqual(script.capability().mode, 'pty-wrapper');
  });

  it('TTY + 无 script：以 stdio inherit 直通启动（argv 走 shell -c）', async () => {
    const executor = new FakeExecutor();
    const tool = new ShellInteractiveTool({ probe: TTY_INHERIT, executor });
    const result = await tool.handle(call({ command: 'vim x.txt' }), ctx);
    assert.strictEqual(result.ok, true, result.error ?? '');
    assert.strictEqual(executor.calls.length, 1);
    const first = executor.calls[0];
    assert.deepStrictEqual(first?.args.slice(-1), ['vim x.txt']);
    assert.strictEqual(first?.options.cwd, process.cwd());
    assert.match(result.output ?? '', /inherit/);
  });

  it('TTY + 有 script：以 GNU script 包装启动（argv[0] = -qec，argv[2] = /dev/null）', async () => {
    const executor = new FakeExecutor();
    const tool = new ShellInteractiveTool({ probe: SCRIPT_TTY, executor });
    const result = await tool.handle(call({ command: 'htop' }), ctx);
    assert.strictEqual(result.ok, true, result.error ?? '');
    const first = executor.calls[0];
    assert.strictEqual(first?.bin, 'script');
    assert.strictEqual(first?.args[0], '-qec');
    assert.strictEqual(first?.args[2], '/dev/null');
    assert.match(first?.args[1] ?? '', /-c 'htop'$/);
    assert.match(result.output ?? '', /script 伪终端/);
  });
});

describe('shell_interactive 退出状态如实回传', () => {
  it('非零退出码原样回传', async () => {
    const executor = new FakeExecutor();
    executor.outcome = { exitCode: 3, signal: null, timedOut: false };
    const tool = new ShellInteractiveTool({ probe: TTY_INHERIT, executor });
    const result = await tool.handle(call({ command: 'exit 3' }), ctx);
    assert.strictEqual(result.ok, false);
    assert.match(result.error ?? '', /退出码 3/);
  });

  it('被信号终止如实回传（不当成成功）', async () => {
    const executor = new FakeExecutor();
    executor.outcome = { exitCode: null, signal: 'SIGINT', timedOut: false };
    const tool = new ShellInteractiveTool({ probe: TTY_INHERIT, executor });
    const result = await tool.handle(call({ command: 'vim' }), ctx);
    assert.strictEqual(result.ok, false);
    assert.match(result.error ?? '', /SIGINT/);
  });

  it('超时如实回传（附生效超时值）', async () => {
    const executor = new FakeExecutor();
    executor.outcome = { exitCode: null, signal: null, timedOut: true };
    const tool = new ShellInteractiveTool({ probe: TTY_INHERIT, executor });
    const result = await tool.handle(call({ command: 'vim', timeout_ms: 1200 }), ctx);
    assert.strictEqual(result.ok, false);
    assert.match(result.error ?? '', /超时（1200ms/);
  });

  it('执行器抛错：ok:false 且不抛给上层', async () => {
    const executor = new FakeExecutor();
    executor.failWith = new Error('spawn EPERM');
    const tool = new ShellInteractiveTool({ probe: TTY_INHERIT, executor });
    const result = await tool.handle(call({ command: 'vim' }), ctx);
    assert.strictEqual(result.ok, false);
    assert.match(result.error ?? '', /EPERM/);
  });
});

describe('shell_interactive 前置校验与裁决', () => {
  it('空命令被拒绝（不触达执行器）', async () => {
    const executor = new FakeExecutor();
    const tool = new ShellInteractiveTool({ probe: TTY_INHERIT, executor });
    const result = await tool.handle(call({ command: '   ' }), ctx);
    assert.strictEqual(result.ok, false);
    assert.match(result.error ?? '', /命令为空/);
    assert.deepStrictEqual(executor.calls, []);
  });

  it('超长命令被拒绝', async () => {
    const tool = new ShellInteractiveTool({
      probe: TTY_INHERIT,
      executor: new FakeExecutor(),
      maxCommandLength: 10,
    });
    const result = await tool.handle(call({ command: 'x'.repeat(100) }), ctx);
    assert.strictEqual(result.ok, false);
    assert.match(result.error ?? '', /命令过长/);
  });

  it('裁决器拒绝时不执行', async () => {
    const executor = new FakeExecutor();
    const tool = new ShellInteractiveTool({
      probe: TTY_INHERIT,
      executor,
      guard: (command) => (command.includes('rm -rf') ? '危险命令被裁决器拒绝' : undefined),
    });
    const result = await tool.handle(call({ command: 'rm -rf /' }), ctx);
    assert.strictEqual(result.ok, false);
    assert.match(result.error ?? '', /裁决器拒绝/);
    assert.deepStrictEqual(executor.calls, []);
  });

  it('enforce 策略下被拒（工具层纵深与 shell 同口径）', async () => {
    const executor = new FakeExecutor();
    const tool = new ShellInteractiveTool({
      probe: TTY_INHERIT,
      executor,
      policy: new ShellCommandPolicy({ mode: 'enforce', denyPrograms: ['curl'] }),
    });
    const result = await tool.handle(call({ command: 'curl http://evil.example' }), ctx);
    assert.strictEqual(result.ok, false);
    assert.match(result.error ?? '', /策略拒绝/);
    assert.deepStrictEqual(executor.calls, []);
  });

  it('工具元数据：名称/必填参数/超时说明齐备', () => {
    const tool = new ShellInteractiveTool({ probe: NO_TTY, executor: new FakeExecutor() });
    assert.strictEqual(tool.definition.name, 'shell_interactive');
    assert.deepStrictEqual(tool.definition.parameters.required, ['command']);
    assert.ok(tool.definition.parameters.properties['timeout_ms'] !== undefined);
    assert.ok(tool.definition.parameters.properties['command'] !== undefined);
    assert.match(tool.definition.description, /非 TTY 环境会明确失败/);
  });
});
