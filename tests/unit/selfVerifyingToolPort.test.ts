/**
 * P3 自验证回环装饰器单测（零依赖；内层端口与命令执行器均为替身）。
 *
 * 覆盖：触发器门控、失败摘要回灌、通过静默、预算与冷却、假完成探测、
 * fail-open（命令抛错不改变 ok）、ToolPort 透传。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { SelfVerifyingToolPort } from '../../src/adapters/tool/verify/selfVerifyingToolPort.js';
import { SelfVerifyPolicy } from '../../src/adapters/tool/verify/selfVerifyPolicy.js';
import type {
  TestCommandRunner,
  TestRunOutcome,
} from '../../src/adapters/tool/verify/testCommandRunner.js';
import type { ToolCall, ToolContext, ToolPort, ToolResult } from '../../src/ports/tool/tool.js';

/** 可注入时钟（用于精确控制冷却窗口与预算判定）。 */
class Clock {
  /** 当前毫秒时间戳（可经 {@link advance} 推进）。 */
  public value = 1_000_000;

  /** 读取当前时间（作为被测端口的 `now` 注入）。 */
  public readonly now = (): number => this.value;

  /**
   * 推进时钟。
   *
   * @param ms 前进的毫秒数。
   * @returns 无返回值。
   */
  public advance(ms: number): void {
    this.value += ms;
  }
}

/** 命令执行器替身（记录调用次数，可配置返回结果或抛错）。 */
class StubRunner implements TestCommandRunner {
  /** 已被调用的次数。 */
  public calls = 0;

  /**
   * @param outcome 返回给调用方的执行结果（缺省为「成功且无输出」）。
   * @param boom 为 true 时抛出错误（模拟子进程无法启动）。
   */
  public constructor(
    private readonly outcome: TestRunOutcome = { exitCode: 0, output: '', timedOut: false },
    private readonly boom = false,
  ) {}

  /**
   * 记录一次调用并返回预设结果。
   *
   * @returns 预设的执行结果；`boom` 为 true 时抛出错误。
   */
  public async run(): Promise<TestRunOutcome> {
    this.calls += 1;
    if (this.boom) {
      throw new Error('spawn failed');
    }
    return this.outcome;
  }
}

/** 内层工具端口替身（固定返回给定结果）。 */
const innerPort = (result: ToolResult): ToolPort => ({
  name: 'stub-registry',
  list: () => [
    { name: 'write_file', description: 'write', parameters: { type: 'object', properties: {} } },
  ],
  execute: async (): Promise<ToolResult> => result,
});

/** 测试用调用与上下文。 */
const call: ToolCall = {
  id: 'c1',
  name: 'write_file',
  arguments: { path: 'src/a.ts', content: 'export const a = 1;' },
};
const ctx: ToolContext = { sessionId: 's1', workspaceRoot: '/repo' };

/** 组装被测端口（默认：触发器命中、无假完成探测、默认策略）。 */
const build = (
  result: ToolResult,
  runner: StubRunner,
  overrides: {
    shouldVerify?: boolean;
    clock?: Clock;
    policy?: SelfVerifyPolicy;
    probe?: () => string | undefined;
  } = {},
): SelfVerifyingToolPort => {
  const clock = overrides.clock ?? new Clock();
  return new SelfVerifyingToolPort(innerPort(result), {
    policy: overrides.policy ?? SelfVerifyPolicy.from(),
    workspaceRoot: '/repo',
    runner,
    shouldVerify: () => overrides.shouldVerify ?? true,
    now: clock.now,
    ...(overrides.probe !== undefined ? { probeFakeCompletion: overrides.probe } : {}),
  });
};

test('触发器命中且测试失败 → 回灌失败摘要', async () => {
  const runner = new StubRunner({
    exitCode: 1,
    output: 'ok 1 - a\nnot ok 2 - b\nAssertionError: expected 1 to equal 2',
    timedOut: false,
  });
  const port = build({ callId: 'c1', ok: true, output: 'wrote src/a.ts' }, runner);
  const out = await port.execute(call, ctx);
  assert.strictEqual(out.ok, true);
  assert.ok(out.output?.includes('wrote src/a.ts'));
  assert.ok(out.output?.includes('[自验证回环]'));
  assert.ok(out.output?.includes('not ok 2 - b'));
  assert.strictEqual(runner.calls, 1);
});

test('测试通过 → 静默（output 原样）', async () => {
  const runner = new StubRunner({ exitCode: 0, output: 'all pass', timedOut: false });
  const port = build({ callId: 'c1', ok: true, output: 'wrote' }, runner);
  const out = await port.execute(call, ctx);
  assert.strictEqual(out.output, 'wrote');
  assert.strictEqual(runner.calls, 1);
});

test('超时 → 回灌超时提示', async () => {
  const runner = new StubRunner({ exitCode: null, output: '', timedOut: true });
  const port = build({ callId: 'c1', ok: true, output: 'wrote' }, runner);
  const out = await port.execute(call, ctx);
  assert.ok(out.output?.includes('超时'));
});

test('非触发器 / 结果失败 → 完全不跑命令', async () => {
  const runner = new StubRunner();
  const noTrigger = build({ callId: 'c1', ok: true, output: 'x' }, runner, {
    shouldVerify: false,
  });
  await noTrigger.execute(call, ctx);
  assert.strictEqual(runner.calls, 0);

  const failed = build({ callId: 'c1', ok: false, error: 'boom' }, runner);
  const out = await failed.execute(call, ctx);
  assert.strictEqual(out.output, undefined);
  assert.strictEqual(runner.calls, 0);
});

test('冷却窗口内不重复跑；窗口过后可再跑', async () => {
  const clock = new Clock();
  const runner = new StubRunner({ exitCode: 1, output: 'not ok 1', timedOut: false });
  const port = build({ callId: 'c1', ok: true, output: 'w' }, runner, { clock });
  await port.execute(call, ctx);
  await port.execute(call, ctx);
  assert.strictEqual(runner.calls, 1, '冷却窗口内第二次不应触发');
  clock.advance(SelfVerifyPolicy.DEFAULT_COOLDOWN_MS + 1);
  await port.execute(call, ctx);
  assert.strictEqual(runner.calls, 2);
});

test('每会话次数预算硬上限', async () => {
  const clock = new Clock();
  const runner = new StubRunner({ exitCode: 1, output: 'not ok 1', timedOut: false });
  const port = build({ callId: 'c1', ok: true, output: 'w' }, runner, {
    clock,
    policy: SelfVerifyPolicy.from({ maxRunsPerSession: 1, cooldownMs: 0 }),
  });
  await port.execute(call, ctx);
  clock.advance(10);
  await port.execute(call, ctx);
  clock.advance(10);
  await port.execute(call, ctx);
  assert.strictEqual(runner.calls, 1);
});

test('假完成探测命中 → 即使测试通过也回灌提示', async () => {
  const runner = new StubRunner({ exitCode: 0, output: '', timedOut: false });
  const port = build({ callId: 'c1', ok: true, output: 'w' }, runner, {
    probe: () => '产物 src/a.ts 含未完成标记（no-placeholders）',
  });
  const out = await port.execute(call, ctx);
  assert.ok(out.output?.includes('[自验证·假完成探测]'));
  assert.ok(out.output?.includes('未完成标记'));
});

test('命令抛错 → fail-open（不改变 ok，仅附提示）', async () => {
  const runner = new StubRunner({ exitCode: 0, output: '', timedOut: false }, true);
  const port = build({ callId: 'c1', ok: true, output: 'w' }, runner);
  const out = await port.execute(call, ctx);
  assert.strictEqual(out.ok, true);
  assert.ok(out.output?.includes('未能执行'));
});

test('无 output 且命中回灌 → output 直接为回灌段', async () => {
  const runner = new StubRunner({ exitCode: 2, output: 'not ok 1 - x', timedOut: false });
  const port = build({ callId: 'c1', ok: true }, runner);
  const out = await port.execute(call, ctx);
  assert.ok(out.output?.startsWith('[自验证回环]'));
});

test('ToolPort 透传：name / list / listDirect / unregister', () => {
  const runner = new StubRunner();
  const port = build({ callId: 'c1', ok: true, output: 'w' }, runner);
  assert.strictEqual(port.name, 'stub-registry');
  assert.strictEqual(port.list().length, 1);
  assert.strictEqual(port.listDirect().length, 1);
  assert.strictEqual(port.unregister('write_file'), false);
});
