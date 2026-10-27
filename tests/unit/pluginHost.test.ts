import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginHost } from '../../src/server/services/pluginHost.ts';
import { PluginHostPermissions } from '../../src/server/services/pluginHostPermissions.ts';
import type { Transport } from '../../src/server/transport/lineTransport.ts';
import type { RpcMessage } from '../../src/server/core/jsonRpc.ts';
import { ConfigFactory } from '../../src/config/configFactory.ts';
import { MockModel } from '../../src/adapters/model/mockModel.ts';
import { MemoryStorage } from '../../src/adapters/storage/memoryStorage.ts';
import { SilentEventPort } from '../../src/adapters/event/silentEventPort.ts';
import { AutoApproval } from '../../src/adapters/approval/autoApproval.ts';
import { PassthroughSandbox } from '../../src/adapters/sandbox/passthroughSandbox.ts';
import { DANGEROUS_PERMISSIONS } from '../../src/plugin/permission.ts';

/** 空传输桩。 */
class NoopTransport implements Transport {
  public send(_message: RpcMessage): void {}
  public onMessage(): void {}
}

/** 构造宿主：插件目录缺省即"插件未启用"。 */
function build(pluginsDir: string | undefined): PluginHost {
  return new PluginHost({
    pluginsDir,
    // 若配置被读取说明早退失效——本桩用于证伪。
    baseConfig: () => {
      throw new Error('不应读取配置');
    },
    transport: new NoopTransport(),
    registry: undefined,
    messageOf: (error) => String(error),
  });
}

test('PluginHost：未配置插件目录时 ensure 早退且不触达配置', async () => {
  const host = build(undefined);
  await host.ensure();
  assert.strictEqual(host.manager, undefined);
  assert.strictEqual(host.dir, undefined);
});

test('PluginHost：load 等价于 ensure，重复调用幂等', async () => {
  const host = build(undefined);
  await host.load();
  await host.ensure();
  await host.ensure();
  assert.strictEqual(host.manager, undefined);
});

test('PluginHost.applyProfile：插件系统未初始化时 fail-closed 抛错', async () => {
  const host = build(undefined);
  await assert.rejects(() => host.applyProfile({ name: 'demo', plugins: [] }), /插件系统未初始化/);
});

test('PluginHost：有插件目录时装配出管理器并对外暴露目录', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'plugin-host-'));
  try {
    const config = ConfigFactory.build({
      workspaceRoot: process.cwd(),
      maxSteps: 2,
      model: new MockModel(),
      storage: new MemoryStorage(),
      approvals: new AutoApproval(),
      sandbox: new PassthroughSandbox(),
      events: new SilentEventPort(),
    });
    const host = new PluginHost({
      pluginsDir: dir,
      baseConfig: () => config,
      transport: new NoopTransport(),
      registry: undefined,
      messageOf: (error) => String(error),
    });
    await host.ensure();
    assert.ok(host.manager !== undefined, '有插件目录时应装配出管理器');
    assert.strictEqual(host.dir, dir);
    // 未注入 registry：市场能力不可用，applyProfile 必须 fail-closed。
    await assert.rejects(
      () => host.applyProfile({ name: 'demo', plugins: [] }),
      /插件系统未初始化/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('宿主权限白名单：默认只授非危险权限，proc.exec/env.write 等被拒', () => {
  const gate = PluginHostPermissions.resolve({});
  const dangerous = [...DANGEROUS_PERMISSIONS];
  const decision = gate.check(dangerous);
  assert.strictEqual(
    decision.allowed,
    false,
    '默认白名单不得放行任何危险权限（此前宿主直接授全集）',
  );
  assert.deepStrictEqual(new Set(decision.missing), new Set(dangerous));
  // 非危险能力照常可用。
  assert.strictEqual(
    gate.check(['fs.read', 'net.connect', 'env.read', 'store.read']).allowed,
    true,
  );
});

test('宿主权限白名单：OMNI_PLUGIN_PERMISSIONS 显式授予危险权限 / all 全开 / 未知名忽略', () => {
  const granted = PluginHostPermissions.resolve({ OMNI_PLUGIN_PERMISSIONS: 'proc.exec, nope' });
  assert.strictEqual(granted.check(['proc.exec']).allowed, true, '显式授予后应放行');
  assert.strictEqual(granted.check(['env.write']).allowed, false, '未授予的危险权限仍应被拒');
  const all = PluginHostPermissions.resolve({ OMNI_PLUGIN_PERMISSIONS: 'all' });
  assert.strictEqual(all.check([...DANGEROUS_PERMISSIONS]).allowed, true, 'all 显式全开');
});
