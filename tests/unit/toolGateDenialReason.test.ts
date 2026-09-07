import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PlanPort, PlanState } from '../../src/ports/plan.js';
import type { SandboxAction, SandboxDecision, SandboxPort } from '../../src/ports/sandbox.js';
import type { ToolCall } from '../../src/ports/tool.js';
import { AutoApproval } from '../../src/adapters/approval/autoApproval.js';
import { PlanApproval } from '../../src/adapters/approval/planApproval.js';
import { DenyApproval } from '../../src/adapters/approval/denyApproval.js';
import { PassthroughSandbox } from '../../src/adapters/sandbox/passthroughSandbox.js';
import { DenyEscalation } from '../../src/adapters/escalation/denyEscalation.js';
import { UnsupportedSandbox } from '../../src/adapters/sandbox/unsupportedSandbox.js';
import { ToolGate } from '../../src/core/toolGate.js';

/** Mock PlanPort：可注入任意 PlanState 或 null。 */
class StubPlan implements PlanPort {
  readonly name = 'stub';
  constructor(private readonly state: PlanState | null = null) {}
  // 桩实现：测试不关心 write/present/decide 调用。
  write(): void {}
  present(): void {}
  decide(): void {}
  get(): PlanState | null {
    return this.state;
  }
}

/** Mock 沙箱：永远 deny 任何动作（用于隔离验证 sandbox 拒绝原因）。 */
class DenyingSandbox implements SandboxPort {
  readonly name = 'denying';
  async check(_action: SandboxAction): Promise<SandboxDecision> {
    return { allowed: false, reason: '测试沙箱拒绝原因 XYZ', category: 'command' };
  }
}

function shellCall(command: string): ToolCall {
  return { id: 'c1', name: 'shell', arguments: { command } };
}

describe('ToolGate 拒绝原因透传（#OBS-1）', () => {
  it('plan mode + mutating + plan=null：error 含"plan mode 未提交计划"且指明工具名', async () => {
    const gate = new ToolGate(
      new AutoApproval(),
      new PassthroughSandbox(),
      new StubPlan(null),
      true,
    );
    const r = await gate.gate(shellCall('echo hi'), 's');
    assert.ok(r !== undefined);
    assert.strictEqual(r?.ok, false);
    assert.match(r?.error ?? '', /plan mode 未提交计划/);
    assert.match(r?.error ?? '', /shell/);
  });

  it('plan mode + mutating + plan.status=drafting：error 含"plan mode 未批准"且指明状态', async () => {
    const drafting: PlanState = { status: 'drafting', steps: [] };
    const gate = new ToolGate(
      new AutoApproval(),
      new PassthroughSandbox(),
      new StubPlan(drafting),
      true,
    );
    const r = await gate.gate(shellCall('echo hi'), 's');
    assert.match(r?.error ?? '', /plan mode 未批准/);
    assert.match(r?.error ?? '', /drafting/);
  });

  it('plan mode + mutating + plan.status=approved：放行（return undefined）', async () => {
    const approved: PlanState = { status: 'approved', steps: [{ description: 'x' }] };
    const gate = new ToolGate(
      new AutoApproval(),
      new PassthroughSandbox(),
      new StubPlan(approved),
      true,
    );
    assert.strictEqual(await gate.gate(shellCall('echo hi'), 's'), undefined);
  });

  it('plan mode + 只读工具（list_dir）：放行（plan 门禁不拦只读）', async () => {
    const gate = new ToolGate(
      new AutoApproval(),
      new PassthroughSandbox(),
      new StubPlan(null),
      true,
    );
    const readCall: ToolCall = { id: 'c2', name: 'list_dir', arguments: { path: '.' } };
    assert.strictEqual(await gate.gate(readCall, 's'), undefined);
  });

  it('approval=plan + mutating：error 含审批策略名 + 工具名 + 切换建议', async () => {
    const gate = new ToolGate(new PlanApproval(), new PassthroughSandbox());
    const r = await gate.gate(shellCall('echo hi'), 's');
    assert.match(r?.error ?? '', /plan 策略拒绝/);
    assert.match(r?.error ?? '', /shell/);
    assert.match(r?.error ?? '', /approval=auto/);
  });

  it('approval=deny（always-deny）：error 含"策略拒绝"且不再用旧字符串"被拒绝: <name>"', async () => {
    const gate = new ToolGate(new DenyApproval(), new PassthroughSandbox());
    const r = await gate.gate(shellCall('echo hi'), 's');
    assert.match(r?.error ?? '', /策略拒绝/);
    // 旧字符串已替换为可观测形式
    assert.doesNotMatch(r?.error ?? '', /^被拒绝: shell$/);
  });

  it('sandbox deny + escalation=deny：error 含"sandbox 拒绝" + 类别 + 真实 reason', async () => {
    const gate = new ToolGate(
      new AutoApproval(),
      new DenyingSandbox(),
      undefined,
      false,
      new DenyEscalation(),
      new UnsupportedSandbox('elev', 'fail-closed'),
    );
    const r = await gate.gate(shellCall('rm -rf /'), 's');
    assert.match(r?.error ?? '', /sandbox 拒绝/);
    assert.match(r?.error ?? '', /\[command\]/); // category
    assert.match(r?.error ?? '', /测试沙箱拒绝原因 XYZ/); // 真实 reason
    assert.match(r?.error ?? '', /rm -rf/); // 工具名
  });

  it('sandbox allow：通过（回归保护）', async () => {
    const gate = new ToolGate(new AutoApproval(), new PassthroughSandbox());
    assert.strictEqual(await gate.gate(shellCall('ls'), 's'), undefined);
  });
});
