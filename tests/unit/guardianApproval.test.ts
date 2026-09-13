import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuardianApproval } from '../../src/adapters/approval/guardianApproval.js';
import type { ApprovalRequest } from '../../src/ports/runtime/approval.js';
import type { ModelOutput, ModelPort, ModelRequest } from '../../src/ports/model/model.js';
import { dangerousCommands } from '../../src/adapters/sandbox/dangerousCommands.js';

/** 构造固定输出的假模型。 */
function fakeModel(behavior: () => ModelOutput): ModelPort {
  return {
    name: 'fake',
    async generate(_request: ModelRequest): Promise<ModelOutput> {
      return behavior();
    },
  };
}

/** 构造审批请求。 */
function request(toolName: string, target: string): ApprovalRequest {
  return { sessionId: 's1', toolName, target };
}

/** 构造 Guardian（预检复用危险命令规则）。 */
function guardian(model: ModelPort): GuardianApproval {
  return new GuardianApproval({
    model,
    preDenyPatterns: dangerousCommands.defaults(),
    preAllowPatterns: [/^echo\b/i],
  });
}

test('Guardian：命中预检危险规则直接拒绝（不调模型）', async () => {
  const approval = guardian(
    fakeModel(() => {
      throw new Error('不应调用模型');
    }),
  );
  assert.strictEqual(await approval.decide(request('shell', 'rm -rf /')), 'deny');
});

test('Guardian：命中预检安全规则直接放行（不调模型）', async () => {
  const approval = guardian(
    fakeModel(() => {
      throw new Error('不应调用模型');
    }),
  );
  assert.strictEqual(await approval.decide(request('shell', 'echo hi')), 'allow');
});

test('Guardian：LLM 判定 allow 即放行', async () => {
  const approval = guardian(fakeModel(() => ({ text: 'allow' })));
  assert.strictEqual(await approval.decide(request('shell', 'git push origin main')), 'allow');
});

test('Guardian：LLM 判定 deny 即拦截', async () => {
  const approval = guardian(fakeModel(() => ({ text: 'deny 危险操作' })));
  assert.strictEqual(await approval.decide(request('shell', 'git push origin main')), 'deny');
});

test('Guardian：LLM 输出无法识别默认拒绝', async () => {
  const approval = guardian(fakeModel(() => ({ text: 'maybe' })));
  assert.strictEqual(await approval.decide(request('shell', 'git commit')), 'deny');
});

test('Guardian：模型无文本输出默认拒绝', async () => {
  const approval = guardian(fakeModel(() => ({})));
  assert.strictEqual(await approval.decide(request('shell', 'git commit')), 'deny');
});

test('Guardian：模型异常默认拒绝（fail-closed）', async () => {
  const approval = guardian(
    fakeModel(() => {
      throw new Error('模型不可用');
    }),
  );
  assert.strictEqual(await approval.decide(request('shell', 'git commit')), 'deny');
});
