/**
 * 探针：`StepToolExecutor` 的「tool_call ↔ tool_result 配对」不变量。
 *
 * 被验证的**声称**（三处，互为印证）：
 *  ① `stepToolExecutor.runToolCall` JSDoc：「`pre` 自身抛错直接向上抛，**绝不回退重跑**」；
 *  ② `toolScheduler` 类注释：「单个工具抛异常被捕获并转为 failed ToolResult」；
 *  ③ `contextAssembler.build` 注释：「真实链路中 tool_call 必有后续 tool_result
 *     （stepRunner 即便被门禁拒绝也会补录 toolCall+toolResult）」。
 *
 * 实测：②的 `failed ToolResult` 被 `StepToolExecutor.run` 丢弃（返回值不消费），
 * 于是「记录 tool_call 之后、记录 tool_result 之前」抛出的异常会让事件日志里留下
 * **孤儿 tool_call**：既没有 failed 结果回灌模型，也没有任何日志。投影出的
 * `assistant(tool_calls)` 里就有未被 `tool` 消息响应的 `tool_call_id` —— 上游
 * OpenAI/DeepSeek 兼容端点对此直接 HTTP 400（配对是 wire 层硬要求）。
 *
 * 另一条同源缺陷（同一 try 块）：native 路径的 catch 覆盖了 `recordToolResult` 与
 * `hooks.post`，于是「原生执行成功但 post 钩子抛错」会被误判成「原生执行失败」而
 * **回退到 JS 路径再执行一次**——正是「绝不回退重跑」要防的双写。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { StepToolExecutor } from '../../src/core/stepToolExecutor.js';
import { StepContextBuilder } from '../../src/core/stepContextBuilder.js';
import { AppendOnlyEventLog } from '../../src/core/appendOnlyEventLog.js';
import { SessionRecorder } from '../../src/core/sessionRecorder.js';
import { ToolHookRunner } from '../../src/core/toolHookRunner.js';
import { ContextAssembler } from '../../src/context/contextAssembler.js';
import { AutoApproval } from '../../src/adapters/approval/autoApproval.js';
import { PassthroughSandbox } from '../../src/adapters/sandbox/passthroughSandbox.js';
import type { StepRunnerDeps } from '../../src/core/stepTypes.js';
import type { RepoMapContextEngine } from '../../src/context/repoMapContextEngine.js';
import type { NativeToolRunner } from '../../src/native/nativeBackend.js';
import type { ModelPort } from '../../src/ports/model/model.js';
import type {
  ToolCall,
  ToolContext,
  ToolDefinition,
  ToolPort,
  ToolResult,
} from '../../src/ports/tool/tool.js';
import type { SessionEvent } from '../../src/ports/runtime/event.js';
import type { ToolHookContext } from '../../src/ports/tool/toolHook.js';
import { eventFactory } from '../../src/core/eventFactory.js';

/** 记录被真执行的工具调用名的替身端口（可配置某个工具名抛错）。 */
class RecordingTools implements ToolPort {
  /** 端口名（保持端口契约）。 */
  public readonly name = 'recording';

  /** 实际被派发到 `execute` 的工具名（按序）。 */
  public readonly executed: string[] = [];

  /**
   * @param failing 命中即抛错的工具名判定（模拟工具端口在记录 tool_call 后抛错）。
   */
  public constructor(private readonly failing: (name: string) => boolean = () => false) {}

  /**
   * 空工具清单（本探针不涉及工具枚举）。
   * @returns 空数组。
   */
  public list(): readonly ToolDefinition[] {
    return [];
  }

  /**
   * 记录并（按需）抛错。
   * @param call 工具调用。
   * @param _context 工具上下文（本替身不使用）。
   * @returns 成功结果（未命中抛错判定时）。
   */
  public async execute(call: ToolCall, _context: ToolContext): Promise<ToolResult> {
    this.executed.push(call.name);
    if (this.failing(call.name)) {
      throw new Error(`execute 内部炸了: ${call.name}`);
    }
    return { callId: call.id, ok: true, output: `ok:${call.name}` };
  }
}

/** 探针夹具：真实 recorder + 可配置工具端口 / 钩子 / native。 */
interface Fixture {
  readonly deps: StepRunnerDeps;
  readonly log: AppendOnlyEventLog;
  readonly emitted: SessionEvent[];
}

/**
 * 构造夹具。
 * @param over 需要覆盖的依赖字段（工具端口 / 钩子 / native 等）。
 * @returns 夹具（含事件日志与广播记录，便于断言配对）。
 */
const fixture = (over: Partial<StepRunnerDeps> = {}): Fixture => {
  const log = new AppendOnlyEventLog();
  const emitted: SessionEvent[] = [];
  const recorder = new SessionRecorder(
    log,
    {
      name: 'capture',
      emit: (event: SessionEvent) => {
        emitted.push(event);
      },
    },
    'sess-1',
  );
  const base: StepRunnerDeps = {
    model: {} as ModelPort,
    tools: new RecordingTools(),
    approvals: new AutoApproval(),
    sandbox: new PassthroughSandbox(),
    recorder,
    sessionId: 'sess-1',
    repoMapContext: {} as RepoMapContextEngine,
    ...over,
  };
  return { deps: base, log, emitted };
};

/** 取某类事件的 payload 字段序列。 */
const payloadsOf = <T>(log: AppendOnlyEventLog, type: string, key: string): T[] =>
  log
    .byType(type)
    .map((event) => (event.payload as Record<string, unknown>)[key] as T)
    .filter((value) => value !== undefined);

/** 构造工具上下文。 */
const ctx: ToolContext = { sessionId: 'sess-1', workspaceRoot: process.cwd() };

/** 前置钩子按工具名抛错（模拟插件 pre 钩子否决执行）。 */
const vetoingHooks = (vetoTool: string): ToolHookRunner => {
  const runner = new ToolHookRunner();
  runner.add({
    pre: (context) => {
      if (context.toolName === vetoTool) {
        throw new Error(`插件 pre 钩子否决了 ${vetoTool}`);
      }
    },
  });
  return runner;
};

test('探针①：pre 钩子抛错后，tool_call 仍必须有配对 tool_result（否则上游 HTTP 400）', async () => {
  const f = fixture({ hooks: vetoingHooks('shell') });
  const executor = new StepToolExecutor(f.deps);
  // shell 在 ToolScheduler 里是串行类（含 'shell'），故它先于 read_file 被处理 ⇒ 事件序确定：
  // tool_call(shell) → [异常，无结果] → tool_call(read_file) → tool_result(read_file)
  await executor.run(
    [
      { id: 'c1', name: 'shell', arguments: { command: 'echo hi' } },
      { id: 'c2', name: 'read_file', arguments: { path: 'a.ts' } },
    ],
    ctx,
  );

  const callIds = payloadsOf<string>(f.log, 'tool_call', 'callId');
  const resultIds = payloadsOf<string>(f.log, 'tool_result', 'callId');
  assert.deepStrictEqual(callIds, ['c1', 'c2'], '两个 tool_call 都应落日志');
  for (const id of callIds) {
    assert.ok(
      resultIds.includes(id),
      `tool_call ${id} 没有配对 tool_result（实际结果：${resultIds.join(',')}）`,
    );
  }
  // 失败原因必须回灌给模型（静默消失比失败更糟）。
  const c1 = f.log
    .byType('tool_result')
    .find((event) => (event.payload as { callId?: string }).callId === 'c1');
  assert.ok(c1 !== undefined, 'c1 应有失败结果');
  assert.strictEqual((c1.payload as { ok: boolean }).ok, false, 'c1 应记为失败');
  assert.match(
    String((c1.payload as { error?: string }).error),
    /pre 钩子否决/,
    '失败原因应含钩子抛错信息',
  );
});

test('探针②：投影后的 assistant(tool_calls) 不得留下未被响应的 tool_call_id', async () => {
  const f = fixture({ hooks: vetoingHooks('shell') });
  const executor = new StepToolExecutor(f.deps);
  await executor.run(
    [
      { id: 'c1', name: 'shell', arguments: { command: 'echo hi' } },
      { id: 'c2', name: 'read_file', arguments: { path: 'a.ts' } },
    ],
    ctx,
  );

  const messages = new ContextAssembler().build(f.log.all());
  const answered = new Set(
    messages
      .filter((message) => message.role === 'tool')
      .map((message) => message.toolCallId)
      .filter((id): id is string => id !== undefined),
  );
  const pending: string[] = [];
  for (const message of messages) {
    if (message.role === 'assistant' && message.toolCalls !== undefined) {
      for (const call of message.toolCalls) {
        if (!answered.has(call.id)) {
          pending.push(call.id);
        }
      }
    }
  }
  assert.deepStrictEqual(
    pending,
    [],
    `投影出的 assistant(tool_calls) 有未响应 id：${pending.join(',')}（上游端点会 HTTP 400）`,
  );
});

test('探针③：工具端口在记录 tool_call 后抛错，同样必须补录失败结果', async () => {
  const f = fixture({ tools: new RecordingTools((name) => name === 'grep') });
  const executor = new StepToolExecutor(f.deps);
  await executor.run(
    [
      { id: 'c1', name: 'grep', arguments: { pattern: 'x' } },
      { id: 'c2', name: 'read_file', arguments: { path: 'a.ts' } },
    ],
    ctx,
  );
  const callIds = payloadsOf<string>(f.log, 'tool_call', 'callId');
  const resultIds = payloadsOf<string>(f.log, 'tool_result', 'callId');
  for (const id of callIds) {
    assert.ok(
      resultIds.includes(id),
      `tool_call ${id} 没有配对 tool_result（实际：${resultIds.join(',')}）`,
    );
  }
});

test('探针④：native 执行成功后 post 钩子抛错，绝不回退 JS 路径重跑（写类工具会双写）', async () => {
  const tools = new RecordingTools();
  const native: NativeToolRunner = {
    runTool: (call: ToolCall): ToolResult => ({ callId: call.id, ok: true, output: 'native-ok' }),
  };
  const hooks = new ToolHookRunner();
  hooks.add({
    post: (context: ToolHookContext) => {
      if (context.toolName === 'write_file') {
        throw new Error('post 钩子炸了');
      }
    },
  });
  const f = fixture({ tools, native, hooks });
  const executor = new StepToolExecutor(f.deps);
  await executor.run([{ id: 'c1', name: 'write_file', arguments: { path: 'a.ts' } }], ctx);

  assert.deepStrictEqual(
    tools.executed,
    [],
    'native 已成功执行，不得回退 JS 路径再执行一次（否则写类工具被双写）',
  );
  const results = f.log
    .byType('tool_result')
    .filter((event) => (event.payload as { callId?: string }).callId === 'c1');
  assert.strictEqual(
    results.length,
    1,
    `同一 callId 只能有一条 tool_result（实际 ${results.length} 条）`,
  );
});

test('对照：正常成功路径的配对不受本次修复影响', async () => {
  const f = fixture();
  const executor = new StepToolExecutor(f.deps);
  await executor.run([{ id: 'c1', name: 'read_file', arguments: { path: 'a.ts' } }], ctx);
  const callIds = payloadsOf<string>(f.log, 'tool_call', 'callId');
  const resultIds = payloadsOf<string>(f.log, 'tool_result', 'callId');
  assert.deepStrictEqual(callIds, ['c1']);
  assert.deepStrictEqual(resultIds, ['c1']);
  // 顺带钉住本探针依赖的公共 API 面（StepContextBuilder 再导出 / 事件工厂）。
  assert.strictEqual(typeof StepContextBuilder, 'function');
  assert.strictEqual(eventFactory.sessionMeta('s', '/w').type, 'session_meta');
});
