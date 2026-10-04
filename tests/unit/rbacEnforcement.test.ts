/**
 * F3 执法判据（`ToolGate` 层）：越权调用被拒**且审批端口零调用**。
 *
 * ## 为什么"审批零调用"是判据而不是实现细节
 *
 * 角色决定的是**能力边界**（这个角色根本有没有这项能力），审批决定的是"这一次要不要人点确认"。
 * 若先问审批：越权调用会走到弹框/自动规则那一步——既可能被自动规则放行（真正的绕过），
 * 也浪费一次交互。故本判据在审批端口里放**计数器**，断言越权调用时它恒为 0。
 *
 * 另两条：拒绝原因**可读**（点名角色/工具/缺什么）；**未配置角色策略 ⇒ 逐位不变**（零行为变更）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ToolGate } from '../../src/core/toolGate.js';
import { RbacPolicy } from '../../src/security/rbacPolicy.js';
import { TOOL_NAMES } from '../../src/ports/tool/toolNames.js';
import type { ApprovalPort } from '../../src/ports/runtime/approval.js';
import type { SandboxPort } from '../../src/ports/runtime/sandbox.js';
import type { ToolCall } from '../../src/ports/tool/tool.js';

/**
 * 造一个带调用计数的审批端口（默认放行）。
 * @returns 端口与计数读数
 */
function countingApprovals(): {
  readonly port: ApprovalPort;
  readonly calls: () => number;
} {
  let count = 0;
  const port = {
    decide: (): Promise<{ readonly decision: 'allow' }> => {
      count += 1;
      return Promise.resolve({ decision: 'allow' });
    },
  } as unknown as ApprovalPort;
  return { port, calls: () => count };
}

/** 全放行沙箱（本判据不关心沙箱面；形状对齐既有测试：`check` 而非 `decide`）。 */
const ALLOW_SANDBOX = {
  check: async (): Promise<{ readonly allowed: true }> => ({ allowed: true }),
} as unknown as SandboxPort;

/**
 * 造一个工具调用。
 * @param name 工具名
 * @returns 工具调用
 */
function callOf(name: string): ToolCall {
  return { id: 'c1', name, arguments: {} } as ToolCall;
}

test('F3 执法：越权调用在**审批之前**被拒（审批端口零调用），且原因可读', async () => {
  const approvals = countingApprovals();
  const gate = new ToolGate(
    approvals.port,
    ALLOW_SANDBOX,
    undefined,
    false,
    undefined,
    undefined,
    undefined,
    new RbacPolicy(),
    'viewer',
  );

  const denied = await gate.gate(callOf(TOOL_NAMES.writeFile), 's1');
  assert.ok(denied !== undefined, 'viewer 调写类工具必须被拒');
  assert.strictEqual(denied.ok, false);
  assert.match(String(denied.error), /RBAC/);
  assert.match(String(denied.error), /viewer 无写权限/);
  assert.strictEqual(approvals.calls(), 0, '角色拒绝不得咨询审批（否则可能被自动规则放行）');

  // 治理类：editor 也被拒，同样零审批调用。
  const editorGate = new ToolGate(
    approvals.port,
    ALLOW_SANDBOX,
    undefined,
    false,
    undefined,
    undefined,
    undefined,
    new RbacPolicy(),
    'editor',
  );
  const rollbackDenied = await editorGate.gate(callOf(TOOL_NAMES.rollback), 's1');
  assert.ok(rollbackDenied !== undefined);
  assert.match(String(rollbackDenied.error), /治理类工具/);
  assert.strictEqual(approvals.calls(), 0);

  // 未知角色：全拒（fail-closed），原因点名角色。
  const unknownGate = new ToolGate(
    approvals.port,
    ALLOW_SANDBOX,
    undefined,
    false,
    undefined,
    undefined,
    undefined,
    new RbacPolicy(),
    'ghost',
  );
  const unknownDenied = await unknownGate.gate(callOf(TOOL_NAMES.readFile), 's1');
  assert.ok(unknownDenied !== undefined);
  assert.match(String(unknownDenied.error), /未知角色 "ghost"/);
  assert.strictEqual(approvals.calls(), 0);
});

test('F3 执法：角色放行的调用照常走到审批（正对照，防"一律拒绝"骗过判据）', async () => {
  const approvals = countingApprovals();
  const gate = new ToolGate(
    approvals.port,
    ALLOW_SANDBOX,
    undefined,
    false,
    undefined,
    undefined,
    undefined,
    new RbacPolicy(),
    'editor',
  );
  const allowed = await gate.gate(callOf(TOOL_NAMES.writeFile), 's1');
  assert.strictEqual(allowed, undefined, 'editor 调写类工具应放行（写类仍由审批把关）');
  assert.strictEqual(approvals.calls(), 1, '放行路径必须**真的**咨询审批（否则门禁形同虚设）');
});

test('F3 零行为变更：未配置角色策略（或缺角色名）⇒ 与既有行为逐位一致', async () => {
  const approvals = countingApprovals();
  // 只给策略不给角色名：不得生效（半配置不是"默认 admin"，也不得静默用默认角色）。
  const policyOnly = new ToolGate(
    approvals.port,
    ALLOW_SANDBOX,
    undefined,
    false,
    undefined,
    undefined,
    undefined,
    new RbacPolicy(),
  );
  assert.strictEqual(await policyOnly.gate(callOf(TOOL_NAMES.writeFile), 's1'), undefined);
  assert.strictEqual(approvals.calls(), 1);

  // 只给角色名不给策略：同样不生效。
  const roleOnly = new ToolGate(
    approvals.port,
    ALLOW_SANDBOX,
    undefined,
    false,
    undefined,
    undefined,
    undefined,
    undefined,
    'viewer',
  );
  assert.strictEqual(await roleOnly.gate(callOf(TOOL_NAMES.writeFile), 's1'), undefined);
  assert.strictEqual(approvals.calls(), 2, '半配置必须退化为既有行为，不得半生效');
});
