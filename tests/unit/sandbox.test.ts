import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Sandbox } from '../../src/plugin/sandbox.js';
import { PluginLoader } from '../../src/plugin/pluginLoader.js';
import { PluginManager } from '../../src/plugin/pluginManager.js';
import { Container } from '../../src/core/container.js';
import { RegistryToolPort } from '../../src/adapters/tool/registryToolPort.js';
import { PermissionGate } from '../../src/plugin/permissionGate.js';
import { ALL_PERMISSIONS } from '../../src/plugin/permission.js';

function makeManager(): PluginManager {
  const container = new Container();
  container.register('port.tools', new RegistryToolPort());
  return new PluginManager(container, PermissionGate.fromList(ALL_PERMISSIONS));
}

test('沙箱插件：apply 经 ctx 注册工具，且看不到宿主全局（process 隔离）', async () => {
  const code = `
    const plugin = {
      meta: { name: 'sand-boxed', permissions: ['fs.read'] },
      apply(ctx) {
        let probe;
        try { probe = typeof process; } catch { probe = 'thrown'; }
        ctx.registerService('__probe', probe);
        const tools = ctx.services.get('port.tools');
        tools.register({ name: 'sbox_echo', description: 'echo', parameters: {} }, async (a) => a);
      },
    };
    export default plugin;
  `;
  const plugin = Sandbox.loadPluginCodeInSandbox(code, 'sbox.js');
  const manager = makeManager();
  await manager.register(plugin);
  const container = (manager as unknown as { container: Container }).container;
  assert.strictEqual(
    container.get('__probe'),
    'undefined',
    '沙箱内 typeo(process) 应为 undefined（隔离生效）',
  );
  const tools = container.get('port.tools') as RegistryToolPort;
  assert.ok(
    tools.list().some((t) => t.name === 'sbox_echo'),
    '沙箱插件应成功注册工具',
  );
  assert.strictEqual(manager.isStarted('sand-boxed'), true);
});

test('沙箱插件：禁止 import / require / module', () => {
  assert.throws(
    () => Sandbox.loadPluginCodeInSandbox("import x from 'y'; export default {}", 'bad.js'),
    /禁止/,
  );
  assert.throws(
    () => Sandbox.loadPluginCodeInSandbox("const x = require('x'); export default {}", 'bad.js'),
    /禁止/,
  );
  assert.throws(() => Sandbox.loadPluginCodeInSandbox('module.exports = {};', 'bad.js'), /禁止/);
});

test('沙箱插件：缺 export default 抛错', () => {
  assert.throws(() => Sandbox.loadPluginCodeInSandbox('const a = 1;', 'bad.js'), /export default/);
});

test('沙箱插件：apply 超时熔断', async () => {
  const code = "export default { meta:{name:'hang'}, apply(){ return new Promise(()=>{}); } };";
  const plugin = Sandbox.loadPluginCodeInSandbox(code, 'hang.js', 50);
  const manager = makeManager();
  await assert.rejects(() => manager.register(plugin), /超时/);
});

test('loadInstalledPlugins：source=remote 的已安装插件走沙箱加载', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oh-sbx-inst-'));
  const name = 'sbx-remote';
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(
    join(dir, name, 'index.js'),
    "const p = { meta:{name:'sbx-remote'}, apply(ctx){ const t = ctx.services.get('port.tools'); t.register({name:'sbx_tool',description:'d',parameters:{}}, async()=>({})); } };\nexport default p;\n",
  );
  writeFileSync(
    join(dir, name, 'omni.plugin.json'),
    JSON.stringify({
      name,
      version: '0.1.0',
      source: 'remote',
      entry: 'index.js',
      permissions: [],
    }),
  );
  const manager = makeManager();
  const loaded = await PluginLoader.loadInstalledPlugins(manager, dir);
  assert.deepStrictEqual(loaded, [name], '远程源插件应被沙箱加载');
  const tools = (manager as unknown as { container: Container }).container.get(
    'port.tools',
  ) as RegistryToolPort;
  assert.ok(
    tools.list().some((t) => t.name === 'sbx_tool'),
    '远程源插件的工具应注入工具表',
  );
});
