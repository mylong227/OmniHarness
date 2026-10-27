/**
 * 判据：**命令非零退出不是工具健康失败**（2026-10-27 真实模型跑测暴露）。
 *
 * 现象（`npm run smoke:model` m1/m2 实测）：模型写文件后跑了一次测试，测试红了（`exit 1`）⇒
 * `shell` 作为危险工具被计一次失败 ⇒ `SupervisorKernel` 依 `hazardousFailed` 立即进 `safe` ⇒
 * 之后 `shell` / `write_file` / `subagent` **全被否决**，模型只能反复 `tool_search` 空转
 * （实测 85 步 / 3.4M prompt token），最终无法自我修复。
 *
 * 口径：`exitCode !== 0` 表示**命令执行完了且返回非零**——这是命令结果（红测试、`grep` 无命中、
 * `git diff --exit-code` 等日常情况），不是「工具本身执行失败」。真正的健康失败（超时、被信号
 * 终止、进程异常、写盘异常）仍必须上报，否则监督内核的 fail-closed 就失效了。
 * 因此这里同时钉住两件事：① 非零退出不推进模式；② 真实执行失败仍推进模式（正对照）。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { StepToolExecutor } from '../../src/core/stepToolExecutor.ts';
import { AppendOnlyEventLog } from '../../src/core/appendOnlyEventLog.ts';
import { SessionRecorder } from '../../src/core/sessionRecorder.ts';
import { AutoApproval } from '../../src/adapters/approval/autoApproval.ts';
import { PassthroughSandbox } from '../../src/adapters/sandbox/passthroughSandbox.ts';
import { SupervisorKernel } from '../../src/supervisor/supervisorKernel.ts';
import type { StepRunnerDeps } from '../../src/core/stepTypes.ts';
import type { RepoMapContextEngine } from '../../src/context/repoMap/repoMapContextEngine.ts';
import type { ModelPort } from '../../src/ports/model/model.ts';
import type {
  ToolCall,
  ToolContext,
  ToolDefinition,
  ToolPort,
  ToolResult,
} from '../../src/ports/tool/tool.ts';

/** 固定返回某个结果的工具端口（模拟 shell 的非零退出 / 真实异常）。 */
class FixedResultTools implements ToolPort {
  /** 端口名（保持端口契约）。 */
  public readonly name = 'fixed';

  /**
   * @param resultOf 按工具名产出结果（可返回 `exitCode` 区分「命令结果」与「工具失败」）。
   */
  public constructor(private readonly resultOf: (name: string) => ToolResult) {}

  /**
   * 空工具清单（本判据不涉及工具枚举）。
   * @returns 空数组。
   */
  public list(): readonly ToolDefinition[] {
    return [];
  }

  /**
   * 返回构造时约定的结果。
   * @param call 工具调用。
   * @returns 预置结果（callId 对齐本次调用）。
   */
  public async execute(call: ToolCall): Promise<ToolResult> {
    return { ...this.resultOf(call.name), callId: call.id };
  }
}

/** 构造一个挂了真实监督内核的执行器；危险工具集合与生产装配一致（shell 属于写类）。 */
const makeExecutor = (resultOf: (name: string) => ToolResult) => {
  const supervisor = new SupervisorKernel({ hazardousTools: ['shell', 'write_file'] });
  const deps: StepRunnerDeps = {
    model: {} as ModelPort,
    tools: new FixedResultTools(resultOf),
    approvals: new AutoApproval(),
    sandbox: new PassthroughSandbox(),
    recorder: new SessionRecorder(
      new AppendOnlyEventLog(),
      { name: 'capture', emit: () => undefined },
      'sess-sup',
    ),
    sessionId: 'sess-sup',
    repoMapContext: {} as RepoMapContextEngine,
    supervisor,
  };
  return { executor: new StepToolExecutor(deps), supervisor };
};

/** 工具上下文（工作区取进程当前目录即可，本判据不落盘）。 */
const ctx: ToolContext = { sessionId: 'sess-sup', workspaceRoot: process.cwd() };

test('红测试（命令退出码 1）连续 5 次不推进 safe：模型仍能继续读写', async () => {
  const { executor, supervisor } = makeExecutor((name) =>
    name === 'shell'
      ? {
          callId: '',
          ok: false,
          exitCode: 1,
          error: '命令退出码 1',
          output: 'not ok 1 - F1 ...',
        }
      : { callId: '', ok: true, output: 'written' },
  );
  for (let i = 0; i < 5; i += 1) {
    await executor.run(
      [{ id: `s${String(i)}`, name: 'shell', arguments: { command: 'node --test' } }],
      ctx,
    );
  }
  assert.strictEqual(
    supervisor.mode(),
    'nominal',
    '命令已执行完但非零退出属命令结果，不得被计为工具健康失败（否则一次红测试锁死整个会话）',
  );
  assert.strictEqual(supervisor.intercept('write_file'), undefined, 'safe 未触发时写类工具应放行');
});

test('正对照：真实执行失败（无退出码）仍计数，样本够了照常降级', async () => {
  const { executor, supervisor } = makeExecutor(() => ({
    callId: '',
    ok: false,
    error: '进程异常：spawn ENOENT',
  }));
  await executor.run([{ id: 's1', name: 'shell', arguments: { command: 'x' } }], ctx);
  assert.strictEqual(supervisor.mode(), 'degraded', '单次真实失败先降 degraded（不拦工具）');
  for (let i = 1; i < 4; i += 1) {
    await executor.run([{ id: `s${String(i)}`, name: 'shell', arguments: { command: 'x' } }], ctx);
  }
  assert.strictEqual(supervisor.mode(), 'safe', '真实工具失败 4/4 仍必须触发降级（fail-closed）');
  assert.ok(supervisor.intercept('write_file'), 'safe 下危险工具应被否决');
});

test('正对照：命令超时（子进程未正常退出，无 exitCode）仍计数', async () => {
  const { executor, supervisor } = makeExecutor(() => ({
    callId: '',
    ok: false,
    error: '命令超时（30000ms）',
  }));
  await executor.run([{ id: 's1', name: 'shell', arguments: { command: 'x' } }], ctx);
  assert.strictEqual(supervisor.mode(), 'degraded', '超时不是「执行完的命令结果」，必须计数');
});
