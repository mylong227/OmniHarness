import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ToolGate } from '../../src/core/toolGate.js';
import { AutoEscalation } from '../../src/adapters/escalation/autoEscalation.js';
import { PolicySandbox } from '../../src/adapters/sandbox/policySandbox.js';
import { RestrictedSandbox } from '../../src/adapters/sandbox/restrictedSandbox.js';
import { AutoApproval } from '../../src/adapters/approval/autoApproval.js';

/**
 * P2 缺口跟踪测试（环境受限，当前 skip）：
 *
 * 提权升级（escalate → elevatedSandbox 复核）的真实沙箱行为依赖真机特权
 * —— Windows RestrictedToken / landlock / seatbelt / bwrap 需在特权进程内才能真正
 * 收紧权限。当前编排层在测试中一律用 PassthroughSandbox 作 elevatedSandbox（见
 * sandboxEscalation.test.ts 的 AutoEscalation 用例），仅验证逻辑闭环，未验证
 * 「提权后沙箱确实收紧而非放行一切」。
 *
 * 待真机（Linux landlock / macOS seatbelt / Windows RestrictedToken）补齐后，
 * 把下方 skip 解除，并断言：
 *  1. 升级后的 elevatedSandbox 是真实受限后端（RestrictedSandbox 或 OS 级），
 *     而非 PassthroughSandbox（name !== 'passthrough'）。
 *  2. 被基础 PolicySandbox 拒绝的危险命令（如 `rm -rf /`）经 AutoEscalation
 *     提权后，仍被 elevatedSandbox 二次裁决拦截（绝不能因升级而变成全放行）。
 *  3. 仅「安全命令 + 工作区内路径」经升级后可被 elevatedSandbox 放行。
 */
describe('提权升级 · 真实沙箱复核（P2，环境受限 skip）', () => {
  it(
    'elevatedSandbox 应为真实受限后端而非 Passthrough',
    {
      skip: 'requires real-machine privilege (Windows RestrictedToken / landlock / seatbelt / bwrap)',
    },
    async () => {
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
    },
  );
});
