// ToolGate 多文件 apply_patch：审批必须看到全部目标，沙箱必须逐个目标检查。
//
// 缺陷形态：旧实现只从补丁里取**首个** `+++` 目标。多文件补丁的后续文件既不会出现在审批
// 文案里，也不会过沙箱——用户以为只改一个文件，实际改了三个（2026-10-18 审查 H9）。

import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import type {
  ApprovalDecision,
  ApprovalPort,
  ApprovalRequest,
} from '../../src/ports/runtime/approval.ts';
import type {
  SandboxAction,
  SandboxDecision,
  SandboxPort,
} from '../../src/ports/runtime/sandbox.ts';
import type { ToolCall } from '../../src/ports/tool/tool.ts';
import { ToolGate } from '../../src/core/toolGate.ts';

/** 记录审批请求并固定放行。 */
class RecordingApproval implements ApprovalPort {
  public readonly name = 'recording';
  public readonly targets: string[] = [];
  public async decide(request: ApprovalRequest): Promise<ApprovalDecision> {
    this.targets.push(request.target);
    return 'allow';
  }
}

/** 记录沙箱动作；按 target 决定是否拒绝。 */
class RecordingSandbox implements SandboxPort {
  public readonly name = 'recording';
  public readonly actions: SandboxAction[] = [];
  public constructor(private readonly deniedTarget?: string) {}
  public async check(action: SandboxAction): Promise<SandboxDecision> {
    this.actions.push(action);
    return action.target === this.deniedTarget
      ? { allowed: false, reason: '目标被拒绝', category: 'path' }
      : { allowed: true };
  }
}

const patchOf = (files: readonly string[]): string =>
  files
    .flatMap((file) => [`--- a/${file}`, `+++ b/${file}`, '@@ -1 +1 @@', '-old', '+new'])
    .join('\n');

const call = (patch: string): ToolCall => ({
  id: 'c1',
  name: 'apply_patch',
  arguments: { patch },
});

describe('ToolGate：多文件 apply_patch', () => {
  it('审批文案包含全部目标，沙箱逐个文件检查', async () => {
    const approvals = new RecordingApproval();
    const sandbox = new RecordingSandbox();
    const gate = new ToolGate(approvals, sandbox);
    const result = await gate.gate(call(patchOf(['a.txt', 'b.txt', 'c.txt'])), 's1');
    assert.strictEqual(result, undefined, '全部目标放行时应通过');
    assert.deepStrictEqual(approvals.targets, ['a.txt, b.txt, c.txt']);
    assert.deepStrictEqual(
      sandbox.actions.map((action) => [action.kind, action.target]),
      [
        ['file_write', 'a.txt'],
        ['file_write', 'b.txt'],
        ['file_write', 'c.txt'],
      ],
    );
  });

  it('任一目标被沙箱拒绝 ⇒ 整条补丁拒绝，并在原因里点名该目标', async () => {
    const approvals = new RecordingApproval();
    const sandbox = new RecordingSandbox('b.txt');
    const gate = new ToolGate(approvals, sandbox);
    const result = await gate.gate(call(patchOf(['a.txt', 'b.txt', 'c.txt'])), 's1');
    assert.ok(result !== undefined);
    assert.strictEqual(result?.ok, false);
    assert.match(result?.error ?? '', /b\.txt/u);
    assert.deepStrictEqual(
      sandbox.actions.map((action) => action.target),
      ['a.txt', 'b.txt'],
      '拒绝后不应继续检查后面的目标（fail-closed）',
    );
  });

  it('删除文件：目标取 `---` 一侧，不把 /dev/null 当路径', async () => {
    const approvals = new RecordingApproval();
    const sandbox = new RecordingSandbox();
    const gate = new ToolGate(approvals, sandbox);
    const patch = ['--- a/gone.txt', '+++ /dev/null', '@@ -1 +0,0 @@', '-old'].join('\n');
    assert.strictEqual(await gate.gate(call(patch), 's1'), undefined);
    assert.deepStrictEqual(approvals.targets, ['gone.txt']);
    assert.deepStrictEqual(
      sandbox.actions.map((action) => action.target),
      ['gone.txt'],
    );
  });

  it('patch_candidates：审批/沙箱看到所有候选的全部目标', async () => {
    const approvals = new RecordingApproval();
    const sandbox = new RecordingSandbox();
    const gate = new ToolGate(approvals, sandbox);
    const result = await gate.gate(
      {
        id: 'c2',
        name: 'patch_candidates',
        arguments: { candidates: [patchOf(['a.txt']), patchOf(['b.txt', 'c.txt'])] },
      },
      's1',
    );
    assert.strictEqual(result, undefined);
    assert.deepStrictEqual(approvals.targets, ['a.txt, b.txt, c.txt']);
    assert.deepStrictEqual(
      sandbox.actions.map((action) => [action.kind, action.target]),
      [
        ['file_write', 'a.txt'],
        ['file_write', 'b.txt'],
        ['file_write', 'c.txt'],
      ],
    );
  });
});
