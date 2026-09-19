/**
 * 自验证「定向测试 + 位置候选」单测（P1-⑨ 后半 / P1-⑩）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { SelfVerifyPolicy } from '../../src/adapters/tool/verify/selfVerifyPolicy.js';
import { SelfVerifyingToolPort } from '../../src/adapters/tool/verify/selfVerifyingToolPort.js';
import type {
  TestCommandRunner,
  TestRunOutcome,
} from '../../src/adapters/tool/verify/testCommandRunner.js';
import type { ToolCall, ToolContext, ToolPort, ToolResult } from '../../src/ports/tool/tool.js';

/** 内层端口替身（固定返回写成功）。 */
const innerPort: ToolPort = {
  name: 'stub',
  list: () => [
    { name: 'write_file', description: 'w', parameters: { type: 'object', properties: {} } },
  ],
  execute: async (): Promise<ToolResult> => ({ callId: 'c1', ok: true, output: 'wrote' }),
};

/** 测试用调用与上下文。 */
const call: ToolCall = {
  id: 'c1',
  name: 'write_file',
  arguments: { path: 'src/a.ts', content: 'x' },
};
const ctx: ToolContext = { sessionId: 's1', workspaceRoot: '/repo' };

/**
 * 记录命令并按序返回预设结果的执行器替身。
 */
class ScriptedRunner implements TestCommandRunner {
  /** 依次收到的命令。 */
  public readonly commands: string[] = [];

  /**
   * @param outcomes 按调用次序返回的结果（用尽后重复最后一条）。
   */
  public constructor(private readonly outcomes: readonly TestRunOutcome[]) {}

  /**
   * 记录命令并返回预设结果。
   *
   * @param command 本次执行的命令文本。
   * @returns 预设执行结果。
   */
  public async run(command: string): Promise<TestRunOutcome> {
    this.commands.push(command);
    const index = Math.min(this.commands.length - 1, this.outcomes.length - 1);
    return this.outcomes[index] ?? { exitCode: 0, output: '', timedOut: false };
  }
}

test('narrowedCommand：npm test 收窄到失败测试文件；其它命令/非测试文件不改写', () => {
  assert.strictEqual(
    SelfVerifyPolicy.from({ command: 'npm test' }).narrowedCommand(['src/a.test.ts']),
    'npm test -- src/a.test.ts',
  );
  assert.strictEqual(
    SelfVerifyPolicy.from({ command: 'npm run test' }).narrowedCommand(['a.test.ts', 'b.spec.tsx']),
    'npm run test -- a.test.ts b.spec.tsx',
  );
  // 无目标 ⇒ 原命令
  assert.strictEqual(
    SelfVerifyPolicy.from({ command: 'npm test' }).narrowedCommand([]),
    'npm test',
  );
  // 只有被测源码（堆栈帧常见形态）⇒ 不做定向，避免运行器「没有匹配的测试」假失败
  assert.strictEqual(
    SelfVerifyPolicy.from({ command: 'npm test' }).narrowedCommand(['src/core/foo.ts']),
    'npm test',
  );
  // 源码与测试混在一起 ⇒ 只取测试文件
  assert.strictEqual(
    SelfVerifyPolicy.from({ command: 'npm test' }).narrowedCommand([
      'src/core/foo.ts',
      'tests/unit/foo.test.ts',
    ]),
    'npm test -- tests/unit/foo.test.ts',
  );
  // 非 npm test 形态 ⇒ 不做猜测性拼接
  assert.strictEqual(
    SelfVerifyPolicy.from({ command: 'pytest -q' }).narrowedCommand(['tests/test_a.py']),
    'pytest -q',
  );
  // 目标数封顶
  const many = Array.from({ length: 20 }, (_unused, index) => `f${index}.test.ts`);
  const narrowed = SelfVerifyPolicy.from({ command: 'npm test' }).narrowedCommand(many);
  assert.strictEqual(narrowed.split('--')[1]?.trim().split(' ').length, 8);
});

test('首次失败：回灌含失败摘要 + 位置候选；第二次改用收窄命令；跑通后回归全量', async () => {
  const runner = new ScriptedRunner([
    {
      exitCode: 1,
      output: ['not ok 3 - 用例失败', '    at Object.<anonymous> (src/a.test.ts:12:5)'].join('\n'),
      timedOut: false,
    },
    { exitCode: 1, output: 'not ok 1 - 仍然失败\n    at src/a.test.ts:12:5', timedOut: false },
    { exitCode: 0, output: 'all pass', timedOut: false },
    { exitCode: 1, output: 'not ok 1 - x\n    at src/a.test.ts:1:1', timedOut: false },
  ]);
  const port = new SelfVerifyingToolPort(innerPort, {
    policy: SelfVerifyPolicy.from({ command: 'npm test', cooldownMs: 0, maxRunsPerSession: 10 }),
    workspaceRoot: '/repo',
    runner,
    shouldVerify: () => true,
  });

  const first = await port.execute(call, ctx);
  assert.ok(
    first.output?.includes('位置候选（文件:行）：src/a.test.ts:12'),
    `实际: ${first.output}`,
  );

  await port.execute(call, ctx);
  assert.strictEqual(runner.commands[1], 'npm test -- src/a.test.ts', '第二次应定向到失败文件');

  const third = await port.execute(call, ctx);
  assert.strictEqual(third.ok, true);
  assert.strictEqual(runner.commands[2], 'npm test -- src/a.test.ts', '收窄状态保持到跑通为止');
  assert.strictEqual(third.output, 'wrote', '测试通过应静默');

  await port.execute(call, ctx);
  assert.strictEqual(runner.commands[3], 'npm test', '跑通过后应回归全量命令');
});
