import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SandboxAction, SandboxDecision, SandboxPort } from '../../src/ports/sandbox.js';
import type { ToolCall } from '../../src/ports/tool.js';
import { PassthroughSandbox } from '../../src/adapters/sandbox/passthroughSandbox.js';
import { PolicySandbox } from '../../src/adapters/sandbox/policySandbox.js';
import { RestrictedSandbox } from '../../src/adapters/sandbox/restrictedSandbox.js';
import { UnsupportedSandbox } from '../../src/adapters/sandbox/unsupportedSandbox.js';
import { SandboxManager } from '../../src/adapters/sandbox/sandboxManager.js';
import { isLikelySandboxDenied, classifyDenial } from '../../src/adapters/sandbox/denial.js';
import { DenyEscalation } from '../../src/adapters/escalation/denyEscalation.js';
import { AskEscalation } from '../../src/adapters/escalation/askEscalation.js';
import { AutoEscalation } from '../../src/adapters/escalation/autoEscalation.js';
import { AutoApproval } from '../../src/adapters/approval/autoApproval.js';
import { DenyApproval } from '../../src/adapters/approval/denyApproval.js';
import { ToolGate } from '../../src/core/toolGate.js';
import { ConfigFactory } from '../../src/config/configFactory.js';
import { MockModel } from '../../src/adapters/model/mockModel.js';
import { MemoryStorage } from '../../src/adapters/storage/memoryStorage.js';

/** 一律拒绝的测试沙箱（用于确定性验证升级闭环）。 */
class DenyingSandbox implements SandboxPort {
  public readonly name = 'denying';
  public async check(_action: SandboxAction): Promise<SandboxDecision> {
    return { allowed: false, reason: 'test deny', category: 'command' };
  }
}

/** 构造一条 shell 工具调用。 */
function shellCall(command: string): ToolCall {
  return { id: 'c1', name: 'shell', arguments: { command } };
}

describe('EscalationPort 三实现', () => {
  it('DenyEscalation 永不提权（fail-closed）', async () => {
    const port = new DenyEscalation();
    assert.strictEqual(port.name, 'deny');
    assert.strictEqual(
      await port.decide({
        sessionId: 's',
        toolName: 'shell',
        target: 'rm -rf /',
        reason: 'x',
        deniedBy: 'sandbox',
      }),
      'abort',
    );
  });

  it('AutoEscalation 安全命令提权、危险命令 abort', async () => {
    const port = new AutoEscalation();
    assert.strictEqual(port.name, 'auto');
    assert.strictEqual(
      await port.decide({
        sessionId: 's',
        toolName: 'shell',
        target: 'ls -la',
        reason: 'x',
        deniedBy: 'sandbox',
      }),
      'escalate',
    );
    assert.strictEqual(
      await port.decide({
        sessionId: 's',
        toolName: 'shell',
        target: 'rm -rf /',
        reason: 'x',
        deniedBy: 'sandbox',
      }),
      'abort',
    );
  });

  it('AskEscalation 由 askHandler 裁决', async () => {
    const port = new AskEscalation({ askHandler: async () => 'escalate' });
    assert.strictEqual(port.name, 'ask');
    assert.strictEqual(
      await port.decide({
        sessionId: 's',
        toolName: 'shell',
        target: 'ls',
        reason: 'x',
        deniedBy: 'sandbox',
      }),
      'escalate',
    );
  });
});

describe('SandboxManager 多后端（G4）', () => {
  const manager = new SandboxManager(process.cwd());

  it('passthrough/policy/restricted 为真实后端', () => {
    assert.strictEqual(manager.build('passthrough').name, 'passthrough');
    assert.strictEqual(manager.build('policy').name, 'policy');
    assert.strictEqual(manager.build('restricted').name, 'restricted');
  });

  it('OS 级后端在本环境 fail-closed（拒绝 + category=os）', async () => {
    for (const profile of ['landlock', 'seatbelt', 'bwrap'] as const) {
      const decision = await manager.build(profile).check({ kind: 'command', target: 'ls' });
      assert.strictEqual(decision.allowed, false, `${profile} 应 fail-closed`);
      assert.strictEqual(decision.category, 'os');
    }
  });

  it('UnsupportedSandbox 返回平台不支持原因', async () => {
    const sandbox = new UnsupportedSandbox('landlock', '需要 Linux');
    const decision = await sandbox.check({ kind: 'command', target: 'x' });
    assert.strictEqual(decision.allowed, false);
    assert.ok(decision.reason?.includes('平台不支持'));
  });
});

describe('RestrictedSandbox 强化策略', () => {
  const sandbox = new RestrictedSandbox({ workspaceRoot: process.cwd() });

  it('放行工作区内安全命令', async () => {
    const decision = await sandbox.check({ kind: 'command', target: 'ls -la' });
    assert.strictEqual(decision.allowed, true);
  });

  it('拦截网络外联命令并归类为 network', async () => {
    const decision = await sandbox.check({ kind: 'command', target: 'curl https://evil.example' });
    assert.strictEqual(decision.allowed, false);
    assert.strictEqual(decision.category, 'network');
  });

  it('拦截工作区外路径并归类为 path', async () => {
    const decision = await sandbox.check({ kind: 'file_write', target: '/etc/passwd' });
    assert.strictEqual(decision.allowed, false);
    assert.strictEqual(decision.category, 'path');
  });
});

describe('ToolGate 升级审批闭环（G3/G4）', () => {
  it('默认 DenyEscalation：沙箱拒绝即拒绝（保持既有行为）', async () => {
    const gate = new ToolGate(
      new AutoApproval(),
      new DenyingSandbox(),
      undefined,
      false,
      new DenyEscalation(),
    );
    const result = await gate.gate(shellCall('rm -rf /'), 's');
    assert.notStrictEqual(result, undefined);
    assert.strictEqual(result?.ok, false);
  });

  it('AutoEscalation + 提权沙箱：沙箱拒绝后提权放行', async () => {
    const gate = new ToolGate(
      new AutoApproval(),
      new DenyingSandbox(),
      undefined,
      false,
      new AutoEscalation(),
      new PassthroughSandbox(),
    );
    const result = await gate.gate(shellCall('ls -la'), 's');
    assert.strictEqual(result, undefined, '提权后应放行（gate 返回 undefined）');
  });

  it('AskEscalation(escalate) + 提权沙箱：放行', async () => {
    const gate = new ToolGate(
      new AutoApproval(),
      new DenyingSandbox(),
      undefined,
      false,
      new AskEscalation({ askHandler: async () => 'escalate' }),
      new PassthroughSandbox(),
    );
    assert.strictEqual(await gate.gate(shellCall('ls'), 's'), undefined);
  });

  it('AskEscalation(abort)：拒绝', async () => {
    const gate = new ToolGate(
      new AutoApproval(),
      new DenyingSandbox(),
      undefined,
      false,
      new AskEscalation({ askHandler: async () => 'abort' }),
      new PassthroughSandbox(),
    );
    const result = await gate.gate(shellCall('ls'), 's');
    assert.notStrictEqual(result, undefined);
  });

  it('审批策略拒绝不升级（避免绕过既定策略）', async () => {
    const gate = new ToolGate(
      new DenyApproval(),
      new DenyingSandbox(),
      undefined,
      false,
      new AutoEscalation(),
      new PassthroughSandbox(),
    );
    const result = await gate.gate(shellCall('ls -la'), 's');
    assert.notStrictEqual(result, undefined, '审批 deny 即拒绝，升级端口不应被触发');
  });

  it('真实 PolicySandbox 拒绝危险命令 + AutoEscalation 对危险前缀 abort（不绕过）', async () => {
    const policy = new PolicySandbox({ workspaceRoot: process.cwd() });
    const denied = await policy.check({ kind: 'command', target: 'rm -rf /' });
    assert.strictEqual(denied.allowed, false);
    const gate = new ToolGate(
      new AutoApproval(),
      policy,
      undefined,
      false,
      new AutoEscalation(),
      new PassthroughSandbox(),
    );
    const result = await gate.gate(shellCall('rm -rf /'), 's');
    assert.notStrictEqual(
      result,
      undefined,
      'AutoEscalation 对 rm 前缀 abort，危险命令不应被提权放行',
    );
  });
});

describe('沙箱拒绝分类器（G3）', () => {
  it('isLikelySandboxDenied 识别 OS 拒绝签名', () => {
    assert.strictEqual(isLikelySandboxDenied({ stderr: 'bash: /x: Permission denied' }), true);
    assert.strictEqual(isLikelySandboxDenied({ message: 'Operation not permitted' }), true);
    assert.strictEqual(isLikelySandboxDenied({ signal: 'SIGSYS' }), true);
    assert.strictEqual(isLikelySandboxDenied({ message: 'command not found' }), false);
  });

  it('classifyDenial 归类网络/OS/其他', () => {
    assert.strictEqual(
      classifyDenial({ stderr: 'curl: (7) Failed to connect: Connection refused' }),
      'network',
    );
    assert.strictEqual(classifyDenial({ message: 'access is denied' }), 'os');
    assert.strictEqual(classifyDenial({ message: 'something broke' }), 'other');
  });
});

describe('ConfigFactory 注入 escalation/elevatedSandbox', () => {
  it('缺省为 DenyEscalation + PolicySandbox（提权复核 fail-closed 收紧）', () => {
    const config = ConfigFactory.build({
      workspaceRoot: process.cwd(),
      maxSteps: 4,
      model: new MockModel(),
      storage: new MemoryStorage(),
    });
    assert.strictEqual(config.escalation.name, 'deny');
    assert.strictEqual(config.elevatedSandbox.name, 'policy');
  });
});
