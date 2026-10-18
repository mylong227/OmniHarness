import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RegistryToolPort } from '../../src/adapters/tool/registryToolPort.ts';
import { Container } from '../../src/core/container.ts';
import { ServiceKeys } from '../../src/composition/runtime.ts';
import { PluginManager } from '../../src/plugin/pluginManager.ts';
import { PermissionGate } from '../../src/plugin/permissionGate.ts';
import { ALL_PERMISSIONS } from '../../src/plugin/permission.ts';
import { PluginLoader } from '../../src/plugin/pluginLoader.ts';
import { AppServer } from '../../src/server/core/appServer.ts';
import { PluginRegistry } from '../../src/plugin/pluginRegistry.ts';
import { ASCII_TMP } from '../../vitest.workspace.ts';

// Windows 本机用户名含中文 ⇒ 默认 %TEMP% 让 vite 对非 ASCII 路径做 percent-encoding 后解析失败
// （见 vitest.workspace.ts 的 ASCII_TMP 注释）。本判据要在临时目录落盘示范插件再动态 `import()`，
// 故把 TMP/TEMP **局部**指向仓库内全 ASCII 目录。**不可在 workspace 全局改写**：那会让 vite 的
// SSR 转换缓存也落到这里，被 WorkBuddy broker fs-shim 以 EPERM 拦截，连带拖垮整批判据。
mkdirSync(ASCII_TMP, { recursive: true });
if (process.env['TMP'] !== ASCII_TMP) {
  process.env['TMP'] = ASCII_TMP;
  process.env['TEMP'] = ASCII_TMP;
}
import type { Transport } from '../../src/server/transport/lineTransport.ts';
import { tempWorkspace } from '../helpers/tempWorkspace.ts';
import { ConfigFactory } from '../../src/config/configFactory.ts';
import { MockModel } from '../../src/adapters/model/mockModel.ts';
import { MemoryStorage } from '../../src/adapters/storage/memoryStorage.ts';
import { SilentEventPort } from '../../src/adapters/event/silentEventPort.ts';
import { AutoApproval } from '../../src/adapters/approval/autoApproval.ts';
import { PassthroughSandbox } from '../../src/adapters/sandbox/passthroughSandbox.ts';
import { type RpcMessage } from '../../src/server/core/jsonRpc.ts';

/** 在临时目录写一个可加载的工具插件（ESM，注册 ping 工具）。 */
function writeToolPlugin(dir: string, name: string): void {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, 'package.json'), `${JSON.stringify({ type: 'module' })}\n`);
  writeFileSync(
    join(dir, name, 'omni.plugin.json'),
    JSON.stringify({ name, version: '0.1.0', entry: 'index.js', permissions: [] }),
  );
  writeFileSync(
    join(dir, name, 'index.js'),
    `export default {
  meta: { name: '${name}', inject: ['port.tools'] },
  apply(ctx) {
    const tools = ctx.services.get('port.tools');
    tools.register(
      { name: '${name}', description: 'demo', parameters: { type: 'object', properties: {} } },
      async (call) => ({ callId: call.id, ok: true, output: 'pong' }),
    );
  },
};`,
  );
}

test('pluginLoader：扫描 pluginsDir 并把插件工具注册进 RegistryToolPort（闭环核心）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'oh-plug-'));
  writeToolPlugin(root, 'ping-tool');

  const tools = new RegistryToolPort();
  const container = new Container();
  container.register(ServiceKeys.tools, tools);
  const manager = new PluginManager(container, PermissionGate.fromList(ALL_PERMISSIONS));

  const loaded = await PluginLoader.loadInstalledPlugins(manager, root);
  assert.deepStrictEqual(loaded, ['ping-tool'], '应加载新插件');
  assert.ok(
    tools.list().some((t) => t.name === 'ping-tool'),
    '插件工具应已注册进工具端口',
  );

  // 幂等：再次加载不重复注册
  const again = await PluginLoader.loadInstalledPlugins(manager, root);
  assert.deepStrictEqual(again, [], '已加载插件不应重复加载');
  assert.strictEqual(
    tools.list().filter((t) => t.name === 'ping-tool').length,
    1,
    '工具不应重复注册',
  );
});

/** 与 appServer.test.ts 同款的测试传输。 */
class TestTransport implements Transport {
  public readonly sent: RpcMessage[] = [];
  private callback: ((message: RpcMessage) => void) | undefined;
  public send(message: RpcMessage): void {
    this.sent.push(message);
  }
  public onMessage(callback: (message: RpcMessage) => void): void {
    this.callback = callback;
  }
  public async receive(
    method: string,
    params: Record<string, unknown>,
    id = 1,
  ): Promise<RpcMessage> {
    await this.callback?.({ jsonrpc: '2.0', id, method, params });
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const response = this.sent.find((m) => 'id' in m && m.id === id);
      if (response !== undefined) return response;
      await new Promise((r) => setTimeout(r, 5));
    }
    return { jsonrpc: '2.0', id, result: undefined };
  }
}

test('app-server：plugins.reload 加载已安装插件并注入工具表（运行时闭环）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'oh-srv-'));
  // 关键：先以空目录启动，模拟「市场安装前」状态
  const transport = new TestTransport();
  const config = ConfigFactory.build({
    workspaceRoot: tempWorkspace(),
    maxSteps: 16,
    model: new MockModel(),
    storage: new MemoryStorage(),
    approvals: new AutoApproval(),
    sandbox: new PassthroughSandbox(),
    events: new SilentEventPort(),
  });
  const server = new AppServer({
    config,
    transport,
    pluginsDir: root,
    registry: new PluginRegistry({ pluginsDir: root }),
    modelOverrideEnabled: false,
  });
  await server.loadPlugins();

  // 模拟市场安装：把插件写入 pluginsDir
  writeToolPlugin(root, 'reload-tool');

  // reload 应拾取新安装插件并注入工具表（无需重启 serve）
  const res = (await transport.receive('plugins.reload', {}, 1)) as {
    result: { ok: boolean; loaded: string[] };
  };
  assert.strictEqual(res.result.ok, true);
  assert.deepStrictEqual(res.result.loaded, ['reload-tool'], 'reload 应返回新加载的插件');

  assert.ok(
    (config.tools as RegistryToolPort).list().some((t) => t.name === 'reload-tool'),
    '重载后工具应出现在 Agent 工具表',
  );

  const list = (await transport.receive('plugins.list', {}, 2)) as {
    result: Array<{ name: string; loaded: boolean }>;
  };
  const entry = list.result.find((m) => m.name === 'reload-tool');
  assert.ok(entry, 'plugins.list 应包含 reload-tool');
  assert.strictEqual(entry?.loaded, true, '已加载插件应标记 loaded:true');

  // 通知应已下发
  const notified = transport.sent.some((m) => 'method' in m && m.method === 'plugin.loaded');
  assert.ok(notified, '应下发 plugin.loaded 通知');
});
