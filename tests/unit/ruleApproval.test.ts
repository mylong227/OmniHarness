import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RuleApproval } from '../../src/adapters/approval/ruleApproval.js';
import type { ApprovalRequest } from '../../src/ports/runtime/approval.js';

/** 构造审批请求。 */
function request(toolName: string, target: string): ApprovalRequest {
  return { sessionId: 's1', toolName, target };
}

test('规则审批：deny 优先于 allow', async () => {
  const approval = new RuleApproval({
    rules: [
      { toolName: 'shell', commandPrefix: 'rm ', decision: 'allow' },
      { toolName: 'shell', decision: 'deny' },
    ],
  });
  assert.strictEqual(await approval.decide(request('shell', 'rm -rf x')), 'deny');
});

test('规则审批：ask 优先于 allow', async () => {
  const approval = new RuleApproval({
    rules: [
      { toolName: 'shell', decision: 'ask' },
      { toolName: 'shell', decision: 'allow' },
    ],
    askHandler: async () => 'allow',
  });
  assert.strictEqual(await approval.decide(request('shell', 'ls')), 'allow');
});

test('规则审批：工具级过滤', async () => {
  const approval = new RuleApproval({
    rules: [{ toolName: 'shell', commandPrefix: 'rm ', decision: 'deny' }],
    defaultDecision: 'allow',
  });
  assert.strictEqual(await approval.decide(request('shell', 'rm -rf x')), 'deny');
  // 规则仅作用于 shell；read_file 不匹配任何规则，显式 defaultDecision=allow 下放行（验证匹配不跨工具 bleed）。
  assert.strictEqual(await approval.decide(request('read_file', 'rm -rf x')), 'allow');
});

test('规则审批：命令前缀匹配', async () => {
  const approval = new RuleApproval({
    rules: [{ toolName: 'shell', commandPrefix: 'rm ', decision: 'deny' }],
    defaultDecision: 'allow',
  });
  assert.strictEqual(await approval.decide(request('shell', 'rm -rf x')), 'deny');
  assert.strictEqual(await approval.decide(request('shell', 'rmx file')), 'allow');
});

test('规则审批：ask 走回调返回 allow', async () => {
  const approval = new RuleApproval({
    rules: [{ toolName: 'shell', commandPrefix: 'git push', decision: 'ask' }],
    askHandler: async () => 'allow',
  });
  assert.strictEqual(await approval.decide(request('shell', 'git push origin main')), 'allow');
});

test('规则审批：无 ask 回调默认拒绝', async () => {
  const approval = new RuleApproval({
    rules: [{ toolName: 'shell', commandPrefix: 'git push', decision: 'ask' }],
  });
  assert.strictEqual(await approval.decide(request('shell', 'git push origin main')), 'deny');
});

test('规则审批：未命中规则走默认 deny（fail-closed）', async () => {
  // 未显式配置 defaultDecision 时，缺省为 deny：规则未覆盖的请求一律拒绝，而非默认放行。
  const approval = new RuleApproval({ rules: [{ toolName: 'read_file', decision: 'allow' }] });
  assert.strictEqual(await approval.decide(request('shell', 'echo hi')), 'deny');
});

test('规则审批：默认决策可显式配置为 allow', async () => {
  // 显式选择 allow 仍是合法选项（如受控内部环境），但不再是缺省值。
  const approval = new RuleApproval({
    rules: [{ toolName: 'read_file', decision: 'allow' }],
    defaultDecision: 'allow',
  });
  assert.strictEqual(await approval.decide(request('shell', 'echo hi')), 'allow');
});

test('规则审批：空规则集走默认 deny（fail-closed）', async () => {
  const approval = new RuleApproval({ rules: [] });
  assert.strictEqual(await approval.decide(request('shell', 'anything')), 'deny');
});

test('规则审批：commandGlob 命中即拒（参数级约束）', async () => {
  const approval = new RuleApproval({
    rules: [
      { toolName: 'shell', commandGlob: '*| sh', decision: 'deny' },
      { toolName: 'shell', commandGlob: '*curl *', decision: 'deny' },
    ],
    defaultDecision: 'allow',
  });
  // 管道注入到 shell：命令中段命中 glob（前缀匹配无法覆盖这种位置）
  assert.strictEqual(await approval.decide(request('shell', 'echo ok | sh')), 'deny');
  assert.strictEqual(await approval.decide(request('shell', 'curl http://x')), 'deny');
  assert.strictEqual(await approval.decide(request('shell', 'echo hello')), 'allow');
});

test('规则审批：commandPrefix 与 commandGlob 合取（须同时满足）', async () => {
  const approval = new RuleApproval({
    rules: [
      { toolName: 'shell', commandPrefix: 'git ', commandGlob: '*--force*', decision: 'deny' },
    ],
    defaultDecision: 'allow',
  });
  assert.strictEqual(await approval.decide(request('shell', 'git push --force origin')), 'deny');
  // 前缀不满足（非 git 命令，即便含 --force）
  assert.strictEqual(await approval.decide(request('shell', 'npm push --force')), 'allow');
  // glob 不满足（git 但非 force）
  assert.strictEqual(await approval.decide(request('shell', 'git status')), 'allow');
});

test('规则审批：commandGlob 的元字符不被当正则（字面量语义）', async () => {
  const approval = new RuleApproval({
    rules: [{ toolName: 'shell', commandGlob: 'rm *.txt', decision: 'deny' }],
    defaultDecision: 'allow',
  });
  assert.strictEqual(await approval.decide(request('shell', 'rm a.txt')), 'deny');
  assert.strictEqual(await approval.decide(request('shell', 'rm a.txtx')), 'allow');
});
