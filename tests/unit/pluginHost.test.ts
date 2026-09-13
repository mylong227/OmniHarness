import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginHost } from '../../src/server/services/pluginHost.js';
import type { Transport } from '../../src/server/transport/lineTransport.js';
import type { RpcMessage } from '../../src/server/core/jsonRpc.js';
import { ConfigFactory } from '../../src/config/configFactory.js';
import { MockModel } from '../../src/adapters/model/mockModel.js';
import { MemoryStorage } from '../../src/adapters/storage/memoryStorage.js';
import { SilentEventPort } from '../../src/adapters/event/silentEventPort.js';
import { AutoApproval } from '../../src/adapters/approval/autoApproval.js';
import { PassthroughSandbox } from '../../src/adapters/sandbox/passthroughSandbox.js';

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
