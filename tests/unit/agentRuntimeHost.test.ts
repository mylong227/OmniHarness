import { test } from 'vitest';
import assert from 'node:assert/strict';
import { AgentRuntimeHost } from '../../src/server/core/agentRuntimeHost.ts';
import { ServerNoopSupervisor } from '../../src/server/core/serverNoopSupervisor.ts';
import { AUTO_ALLOW, DENY_ALL, RULES_DEFAULT } from '../../src/server/core/appServerState.ts';
import { ConfigFactory } from '../../src/config/configFactory.ts';
import type { ResolvedConfig } from '../../src/config/configFactory.ts';
import type { ApprovalPort } from '../../src/ports/runtime/approval.ts';
import { MockModel } from '../../src/adapters/model/mockModel.ts';
import { MemoryStorage } from '../../src/adapters/storage/memoryStorage.ts';
import { SilentEventPort } from '../../src/adapters/event/silentEventPort.ts';
import { PassthroughSandbox } from '../../src/adapters/sandbox/passthroughSandbox.ts';
import { tempWorkspace } from '../helpers/tempWorkspace.ts';

/** 构造生产级解析配置（mock 适配器，无网络）。 */
function buildConfig(approvals?: ApprovalPort): ResolvedConfig {
  return ConfigFactory.build({
    workspaceRoot: tempWorkspace(),
    maxSteps: 4,
    model: new MockModel(),
    storage: new MemoryStorage(),
    approvals: approvals ?? { name: 'custom', decide: async () => 'allow' },
    sandbox: new PassthroughSandbox(),
    events: new SilentEventPort(),
  });
}

/** 构造运行时宿主（可覆写开关）。 */
function buildHost(
  config: ResolvedConfig,
  over: {
    autoApprove?: boolean;
    approvalOverride?: string;
    configuredApproval?: string;
    approvalUplink?: boolean;
  } = {},
): AgentRuntimeHost {
  const uplink: ApprovalPort = { name: 'uplink', decide: async () => 'deny' };
  return new AgentRuntimeHost({
    baseConfig: () => config,
    skills: undefined,
    eventPort: () => new SilentEventPort(),
    approvalUplink: over.approvalUplink ?? false,
    autoApprove: () => over.autoApprove ?? false,
    approvalOverride: () => over.approvalOverride,
    configuredApproval: () => over.configuredApproval,
    uplink: () => uplink,
    modelOverride: () => undefined,
    workspaceRoot: () => tempWorkspace(),
  });
}

test('ServerNoopSupervisor：恒 nominal、不拦截任何工具', () => {
  const sup = new ServerNoopSupervisor();
  assert.strictEqual(sup.mode(), 'nominal');
  assert.strictEqual(sup.intercept(), undefined);
  assert.strictEqual(sup.attemptRecovery(), 'nominal');
  assert.deepEqual(sup.snapshot().entries, []);
});

test('AgentRuntimeHost.bypassSupervisorKernel：autoApprove 时放宽', () => {
  const host = buildHost(buildConfig(), { autoApprove: true });
  assert.ok(host.bypassSupervisorKernel(buildConfig()) instanceof ServerNoopSupervisor);
});

test('AgentRuntimeHost.bypassSupervisorKernel：approval=auto 覆盖时放宽（回归守卫）', () => {
  const host = buildHost(buildConfig(), { approvalOverride: 'auto' });
  assert.ok(host.bypassSupervisorKernel(buildConfig()) instanceof ServerNoopSupervisor);
});

test('AgentRuntimeHost.bypassSupervisorKernel：落盘 approval=auto（重启后无内存覆盖）也放宽', () => {
  // 历史 bug 回归：UI 选「完全访问」落盘后重启，内存覆盖态为空，此处只看内存覆盖导致
  // supervisor 重新 fail-closed，「完全访问」档静默降级。
  const host = buildHost(buildConfig(), { configuredApproval: 'auto' });
  assert.ok(host.bypassSupervisorKernel(buildConfig()) instanceof ServerNoopSupervisor);
});

test('AgentRuntimeHost.bypassSupervisorKernel：默认保持生产内核', () => {
  const host = buildHost(buildConfig());
  assert.strictEqual(host.bypassSupervisorKernel(buildConfig()), undefined);
});

test('AgentRuntimeHost.resolveApprovals：无覆盖且无上行时沿用配置端口', () => {
  const config = buildConfig();
  const host = buildHost(config);
  assert.strictEqual(host.resolveApprovals(config), config.approvals);
});

test('AgentRuntimeHost.resolveApprovals：approval=auto → AUTO_ALLOW', async () => {
  const config = buildConfig();
  const host = buildHost(config, { approvalOverride: 'auto' });
  const port = host.resolveApprovals(config);
  assert.strictEqual(port.name, AUTO_ALLOW.name);
  assert.strictEqual(await port.decide({ sessionId: 's', toolName: 't', target: 'x' }), 'allow');
});

test('AgentRuntimeHost.resolveApprovals：approval=deny → DENY_ALL', async () => {
  const config = buildConfig();
  const host = buildHost(config, { approvalOverride: 'deny' });
  const port = host.resolveApprovals(config);
  assert.strictEqual(port.name, DENY_ALL.name);
  assert.strictEqual(await port.decide({ sessionId: 's', toolName: 't', target: 'x' }), 'deny');
});

test('AgentRuntimeHost.resolveApprovals：approval=deny 落盘（重启后无覆盖）→ DENY_ALL', async () => {
  const config = buildConfig();
  const host = buildHost(config, { configuredApproval: 'deny' });
  assert.strictEqual(host.resolveApprovals(config).name, DENY_ALL.name);
});

test('AgentRuntimeHost.resolveApprovals：approval=ask → 本地只读放行、其余走上行弹框', async () => {
  const config = buildConfig();
  const host = buildHost(config, { approvalOverride: 'ask' });
  const port = host.resolveApprovals(config);
  assert.strictEqual(port.name, 'ask');
  // 本地只读（与 plan 白名单同源的本地子集）自动放行，不弹框。
  assert.strictEqual(
    await port.decide({ sessionId: 's', toolName: 'read_file', target: 'a.ts' }),
    'allow',
  );
  // 编辑 / 联网 / 命令一律询问（上行兜底应答为 deny）。
  assert.strictEqual(
    await port.decide({ sessionId: 's', toolName: 'write_file', target: 'a.ts' }),
    'deny',
  );
  assert.strictEqual(
    await port.decide({ sessionId: 's', toolName: 'web_search', target: 'https://x' }),
    'deny',
  );
  assert.strictEqual(
    await port.decide({ sessionId: 's', toolName: 'shell', target: 'ls' }),
    'deny',
  );
});

test('AgentRuntimeHost.resolveApprovals：落盘 approval=ask（重启后无覆盖）仍生效', async () => {
  // 历史 bug 回归：approval='ask' 落盘后重启，内存覆盖态为空，启动端口（AutoApproval）
  // 被原样沿用 ⇒ 界面显示「请求批准」、实际全放行。
  const config = buildConfig({ name: 'auto', decide: async () => 'allow' });
  const host = buildHost(config, { configuredApproval: 'ask' });
  const port = host.resolveApprovals(config);
  assert.strictEqual(port.name, 'ask');
  assert.strictEqual(
    await port.decide({ sessionId: 's', toolName: 'shell', target: 'ls' }),
    'deny',
    'ask 档经上行（兜底 deny），绝不沿用启动端口的全放行',
  );
});

test('AgentRuntimeHost.resolveApprovals：autoApprove 压过落盘 ask 档（「总是允许」语义）', () => {
  // 审批弹框里点「总是允许」= 此后不再问：即便落盘档位是 ask，也不得再弹框。
  const config = buildConfig({ name: 'auto', decide: async () => 'allow' });
  const host = buildHost(config, { autoApprove: true, configuredApproval: 'ask' });
  assert.strictEqual(host.resolveApprovals(config).name, AUTO_ALLOW.name);
});

test('AgentRuntimeHost.resolveApprovals：approval=rules 按配置回退', () => {
  const rulesConfig = buildConfig({ name: 'rules', decide: async () => 'allow' });
  assert.strictEqual(
    buildHost(rulesConfig, { approvalOverride: 'rules' }).resolveApprovals(rulesConfig),
    rulesConfig.approvals,
  );
  const customConfig = buildConfig({ name: 'custom', decide: async () => 'allow' });
  const fallback = buildHost(customConfig, { approvalOverride: 'rules' }).resolveApprovals(
    customConfig,
  );
  assert.strictEqual(fallback, RULES_DEFAULT);
  assert.strictEqual(fallback.name, 'rules');
});

test('AgentRuntimeHost.resolveApprovals：落盘 approval=rules + approvalCache 包装端口也沿用配置端口', () => {
  // CachedApproval 的 name 是 'cached'，不能靠端口名识别 rules——落盘值就是 rules 时
  // 配置端口必然按 rules 构建（含自定义 permission.rules 与缓存包装），必须沿用而不是回退。
  const cached = buildConfig({ name: 'cached', decide: async () => 'allow' });
  const host = buildHost(cached, { configuredApproval: 'rules' });
  assert.strictEqual(host.resolveApprovals(cached), cached.approvals);
});

test('AgentRuntimeHost.resolveApprovals：落盘 approval=plan（重启后无覆盖）→ 只读白名单', async () => {
  const config = buildConfig({ name: 'auto', decide: async () => 'allow' });
  const host = buildHost(config, { configuredApproval: 'plan' });
  const port = host.resolveApprovals(config);
  assert.strictEqual(port.name, 'plan');
  assert.strictEqual(
    await port.decide({ sessionId: 's', toolName: 'write_file', target: 'a.ts' }),
    'deny',
  );
});

test('AgentRuntimeHost.resolveApprovals：RULES_DEFAULT 回退端口真的拒绝 rm/del', async () => {
  // 历史缺陷回归：回退端口曾是恒 allow，UI 点「默认」后 rm/del 审批层拦截悄然消失。
  const config = buildConfig({ name: 'auto', decide: async () => 'allow' });
  const host = buildHost(config, { approvalOverride: 'rules' });
  const port = host.resolveApprovals(config);
  assert.strictEqual(
    await port.decide({ sessionId: 's', toolName: 'shell', target: 'rm -rf build' }),
    'deny',
  );
  assert.strictEqual(
    await port.decide({ sessionId: 's', toolName: 'shell', target: 'del foo.txt' }),
    'deny',
  );
  assert.strictEqual(
    await port.decide({ sessionId: 's', toolName: 'shell', target: 'npm test' }),
    'allow',
  );
  assert.strictEqual(
    await port.decide({ sessionId: 's', toolName: 'read_file', target: 'a.ts' }),
    'allow',
  );
});

test('AgentRuntimeHost.resolveApprovals：approvalUplink 开启且非 auto 时走上行', () => {
  const config = buildConfig();
  const host = buildHost(config, { approvalUplink: true });
  assert.strictEqual(host.resolveApprovals(config).name, 'uplink');
});

test('AgentRuntimeHost.agent：懒构造并缓存，失效后重建', () => {
  const host = buildHost(buildConfig());
  const first = host.agent();
  assert.strictEqual(host.agent(), first, '未失效时应复用同一 Agent');
  host.invalidateAgent();
  assert.notStrictEqual(host.agent(), first, '失效后应重建');
});

test('AgentRuntimeHost.graphStore / graphPorts：懒构造并缓存，失效后重建', () => {
  const host = buildHost(buildConfig());
  const store = host.graphStore();
  assert.strictEqual(host.graphStore(), store);
  const ports = host.graphPorts();
  assert.strictEqual(host.graphPorts(), ports);
  host.invalidateGraph();
  assert.notStrictEqual(host.graphStore(), store);
  assert.notStrictEqual(host.graphPorts(), ports);
});

test('AgentRuntimeHost.graphPorts：图运行审批随生效档位（deny 档不再固定 AUTO_ALLOW）', async () => {
  // 历史缺陷回归：图运行端口曾固定 AUTO_ALLOW——「全部拒绝」档下图运行照样产生副作用。
  const config = buildConfig({ name: 'auto', decide: async () => 'allow' });
  const host = buildHost(config, { configuredApproval: 'deny' });
  const ports = host.graphPorts();
  assert.strictEqual(ports.approvals.name, DENY_ALL.name);
  assert.strictEqual(
    await ports.approvals.decide({ sessionId: 's', toolName: 'write_file', target: 'a.ts' }),
    'deny',
  );
});

test('S4：配置失效后「停止」仍能触及退役 Agent（否则 Stop 在 config.update 之后变成空操作）', () => {
  const host = buildHost(buildConfig());
  const first = host.agent();
  const calls: { reason: string; sessionId: string | undefined }[] = [];
  // 用桩替换真实取消：本用例只验证「退役实例是否仍被触及」，不驱动真实回合。
  first.cancelCurrentRun = (reason, sessionId) => {
    calls.push({ reason: String(reason), sessionId });
  };
  // 模拟用户在回合进行中改了配置（config.update / 切换工作区都会走到这里）。
  host.invalidateAgent();
  const second = host.agent();
  assert.notStrictEqual(second, first, '失效后应重建 Agent（前置条件）');

  const touched = host.cancelAll('user', 'thread-1');
  assert.strictEqual(touched, 2, '当前与退役实例都应被触及');
  assert.deepStrictEqual(
    calls,
    [{ reason: 'user', sessionId: 'thread-1' }],
    '退役实例（真正在跑回合的那个）必须被取消——旧实现在这里静默失效',
  );
});
