import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentRuntimeHost } from '../../src/server/core/agentRuntimeHost.js';
import { ServerNoopSupervisor } from '../../src/server/core/serverNoopSupervisor.js';
import { AUTO_ALLOW, DENY_ALL, RULES_DEFAULT } from '../../src/server/core/appServerState.js';
import { ConfigFactory } from '../../src/config/configFactory.js';
import type { ResolvedConfig } from '../../src/config/configFactory.js';
import type { ApprovalPort } from '../../src/ports/runtime/approval.js';
import { MockModel } from '../../src/adapters/model/mockModel.js';
import { MemoryStorage } from '../../src/adapters/storage/memoryStorage.js';
import { SilentEventPort } from '../../src/adapters/event/silentEventPort.js';
import { PassthroughSandbox } from '../../src/adapters/sandbox/passthroughSandbox.js';
import { tempWorkspace } from '../helpers/tempWorkspace.js';

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

test('AgentRuntimeHost.resolveApprovals：approval=ask → 走上行端口', async () => {
  const config = buildConfig();
  const host = buildHost(config, { approvalOverride: 'ask' });
  const port = host.resolveApprovals(config);
  assert.strictEqual(port.name, 'uplink');
});

test('AgentRuntimeHost.resolveApprovals：approval=rules 按配置回退', () => {
  const rulesConfig = buildConfig({ name: 'rules', decide: async () => 'allow' });
  assert.strictEqual(
    buildHost(rulesConfig, { approvalOverride: 'rules' }).resolveApprovals(rulesConfig),
    rulesConfig.approvals,
  );
  const customConfig = buildConfig({ name: 'custom', decide: async () => 'allow' });
  assert.strictEqual(
    buildHost(customConfig, { approvalOverride: 'rules' }).resolveApprovals(customConfig),
    RULES_DEFAULT,
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
