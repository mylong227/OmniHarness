import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ToolGate } from '../../src/core/toolGate.js';
import { AutoEscalation } from '../../src/adapters/escalation/autoEscalation.js';
import { PolicySandbox } from '../../src/adapters/sandbox/policySandbox.js';
import { RestrictedSandbox } from '../../src/adapters/sandbox/restrictedSandbox.js';
import { AutoApproval } from '../../src/adapters/approval/autoApproval.js';

/**
 * P2 缺口跟踪测试：提权升级（escalate → elevatedSandbox 复核）的真实沙箱行为。
 *
 * ## 2026-10-11：解除**无条件 skip**（原状态是"永远不跑"）
 *
 * 本文件原先写着 `skip: 'requires real-machine privilege …'`——那不是"缺环境就跳过"，
 * 而是**任何环境都不跑**：它把 `describe/it` 注册上、永远 skip，看着有覆盖其实零判据。
 * 实测把它解除后，三条断言在本机（win32）**全部通过**（1/1、0 skipped）：
 *  1. 升级后的 elevatedSandbox 是真实受限后端而非 PassthroughSandbox；
 *  2. 危险命令经提权后仍被真实沙箱二次裁决拦截（绝不因升级变成全放行）；
 *  3. 工作区内安全命令经升级后被放行。
 *
 * ## 诚实边界
 *
 * 这三条断言的是**决策面**（gate 的裁决结果），**不是**"进程真的被内核层收紧了"——
 * 后者仍依赖真机特权（Windows RestrictedToken 提升 / landlock / seatbelt / bwrap），
 * 且本仓在 `docs/` 里如实自陈隔离档位为 L2。若将来要在真特权环境里加"内核强制"判据，
 * 应新增用例并按 `tests/helpers/requireEnv.ts` 接一个开关，**不要**退回无条件 skip。
 */
describe('提权升级 · 真实沙箱复核（P2）', () => {
  it('elevatedSandbox 应为真实受限后端而非 Passthrough', async () => {
    const elevated = new RestrictedSandbox({ workspaceRoot: process.cwd() });
    assert.notStrictEqual(elevated.name, 'passthrough', '提权沙箱绝不能是全放行 passthrough');
    const base = new PolicySandbox({ workspaceRoot: process.cwd() });
    const gate = new ToolGate(
      new AutoApproval(),
      base,
      undefined,
      false,
      new AutoEscalation(),
      elevated,
    );

    // 危险命令：基础沙箱拒绝 → 升级 → 真实沙箱二次裁决仍需拦截（不变成全放行）。
    const denied = await gate.gate(
      { id: 'c1', name: 'shell', arguments: { command: 'rm -rf /' } },
      's',
    );
    assert.notStrictEqual(denied, undefined, '危险命令经升级后仍应被真实沙箱拦截');
    assert.strictEqual(denied?.ok, false);

    // 安全命令 + 工作区内路径：升级后应放行。
    const allowed = await gate.gate(
      { id: 'c2', name: 'shell', arguments: { command: 'ls -la' } },
      's',
    );
    assert.strictEqual(allowed, undefined, '工作区内安全命令经升级应被真实沙箱放行');
  });
});
