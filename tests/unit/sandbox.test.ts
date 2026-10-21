import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Sandbox } from '../../src/plugin/sandbox.ts';
import { PluginLoader } from '../../src/plugin/pluginLoader.ts';
import { PluginManager } from '../../src/plugin/pluginManager.ts';
import { Container } from '../../src/core/container.ts';
import { RegistryToolPort } from '../../src/adapters/tool/registryToolPort.ts';
import { PermissionGate } from '../../src/plugin/permissionGate.ts';
import { ALL_PERMISSIONS } from '../../src/plugin/permission.ts';

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
  const plugin = Sandbox.loadPluginCodeInSandbox(code, 'hang.js', 1_000);
  const manager = makeManager();
  await assert.rejects(() => manager.register(plugin), /超时/);
});

test('loadInstalledPlugins：source=remote 默认不加载，显式放行后走沙箱加载', async () => {
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
  const saved = process.env.OMNI_ALLOW_REMOTE_PLUGINS;
  try {
    delete process.env.OMNI_ALLOW_REMOTE_PLUGINS;
    const denied: string[] = [];
    const manager = makeManager();
    const loaded = await PluginLoader.loadInstalledPlugins(manager, dir, (n, error) => {
      denied.push(`${n}:${String(error)}`);
    });
    assert.deepStrictEqual(loaded, [], '远程插件默认必须拒绝加载');
    assert.match(denied[0] ?? '', /OMNI_ALLOW_REMOTE_PLUGINS/, '拒绝原因必须可行动');

    process.env.OMNI_ALLOW_REMOTE_PLUGINS = '1';
    const allowedManager = makeManager();
    const allowed = await PluginLoader.loadInstalledPlugins(allowedManager, dir);
    assert.deepStrictEqual(allowed, [name], '显式放行后远程源插件应被沙箱加载');
    const tools = (allowedManager as unknown as { container: Container }).container.get(
      'port.tools',
    ) as RegistryToolPort;
    assert.ok(
      tools.list().some((t) => t.name === 'sbx_tool'),
      '远程源插件的工具应注入工具表',
    );
  } finally {
    if (saved === undefined) delete process.env.OMNI_ALLOW_REMOTE_PLUGINS;
    else process.env.OMNI_ALLOW_REMOTE_PLUGINS = saved;
  }
});

test('沙箱插件：宿主 console 未被注入（console.log.constructor 逃逸不到宿主 process）', async () => {
  const code = `
    const plugin = {
      meta: { name: 'console-escape' },
      apply(ctx) {
        let escaped;
        try {
          escaped = typeof console.log.constructor('return process')();
        } catch {
          escaped = 'thrown';
        }
        ctx.registerService('__escape', escaped);
      },
    };
    export default plugin;
  `;
  const plugin = Sandbox.loadPluginCodeInSandbox(code, 'escape.js');
  let captured: unknown;
  await plugin.apply({
    services: { get: () => undefined, has: () => false },
    registerService: (_name: string, value: unknown) => {
      captured = value;
    },
  } as never);
  assert.notStrictEqual(captured, 'object', 'console 函数不得来自宿主 realm');
  assert.notStrictEqual(captured, 'function');
});

test('S16：模块顶层死循环在**加载阶段**即被 vm timeout 中止（旧实现在此永久挂住）', () => {
  // 回归（2026-09-26 审计 S16）：旧实现把工厂调用放在宿主线程上直接执行，那一步没有任何超时
  // 保护 —— 顶层 while(true) 会让进程彻底停摆，而「apply 超时」根本没机会生效。
  const code = `
    while (true) {}
    export default { meta: { name: 'spin' }, apply() {} };
  `;
  const started = Date.now();
  assert.throws(
    () => Sandbox.loadPluginCodeInSandbox(code, 'spin.js', 200),
    /超时/,
    '顶层死循环必须报超时',
  );
  assert.ok(Date.now() - started < 5_000, '必须有界失败，而不是挂住');
});

test('S16：apply 的**同步**死循环被 vm timeout 中止（Promise.race 单独做不到）', async () => {
  const code = `
    export default {
      meta: { name: 'spin2' },
      apply() { while (true) {} },
    };
  `;
  const plugin = Sandbox.loadPluginCodeInSandbox(code, 'spin2.js', 200);
  const started = Date.now();
  await assert.rejects(
    async () =>
      await plugin.apply({ services: { get: () => undefined, has: () => false } } as never),
    /超时/,
    'apply 同步死循环必须报超时',
  );
  assert.ok(Date.now() - started < 5_000, '必须有界失败');
});

test('S16：正常插件不受影响（同步段仍照常返回）', async () => {
  const code = `
    export default {
      meta: { name: 'ok' },
      apply(ctx) { ctx.registerService('__ok', 'yes'); },
    };
  `;
  const plugin = Sandbox.loadPluginCodeInSandbox(code, 'ok.js', 1_000);
  let stored;
  await plugin.apply({
    services: { get: () => undefined, has: () => false },
    registerService: (name: string, value: unknown) => {
      stored = [name, value];
    },
  } as never);
  assert.deepStrictEqual(stored, ['__ok', 'yes']);
});
