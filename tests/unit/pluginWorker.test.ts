import { test } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Container } from '../../src/core/container.ts';
import { PluginManager } from '../../src/plugin/pluginManager.ts';
import { PermissionGate } from '../../src/plugin/permissionGate.ts';
import { PluginLoader } from '../../src/plugin/pluginLoader.ts';
import { RemotePlugin } from '../../src/plugin/worker/remotePlugin.ts';
import { RegistryToolPort } from '../../src/adapters/tool/registryToolPort.ts';

/** 建一个临时插件目录 + 清单（可指定父目录，便于 Loader 扫描隔离）。 */
function pluginDir(
  name: string,
  code: string,
  source: 'remote' | 'local' = 'remote',
  root?: string,
): string {
  const base = root ?? mkdtempSync(join(tmpdir(), 'omni-worker-'));
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.mjs'), code, 'utf8');
  writeFileSync(
    join(dir, 'omni.plugin.json'),
    JSON.stringify({ name, version: '1.0.0', source, entry: 'index.mjs' }),
    'utf8',
  );
  return dir;
}

/** 建 manager + 工具端口。 */
function managerWithTools(): { manager: PluginManager; tools: RegistryToolPort } {
  const container = new Container();
  const tools = new RegistryToolPort();
  container.register('port.tools', tools);
  return { manager: new PluginManager(container, PermissionGate.allowAll()), tools };
}

const echoPlugin = `
export default {
  meta: { name: 'worker-demo' },
  async activate(ctx) {
    await ctx.tools.register(
      { name: 'echo', description: 'echo', parameters: { type: 'object', properties: { text: { type: 'string' } } } },
      async (call) => ({ callId: call.id, ok: true, output: 'pid:' + process.pid + ':' + call.arguments.text }),
    );
  },
};
`;

const legacyPlugin = `
export default {
  meta: { name: 'legacy-demo' },
  apply(ctx) {
    ctx.services.get('port.tools').register(
      { name: 'legacy', description: 'legacy', parameters: { type: 'object', properties: {} } },
      async (call) => ({ callId: call.id, ok: true, output: 'legacy-ok' }),
    );
  },
};
`;

const crashPlugin = `
export default {
  meta: { name: 'crash-demo' },
  async activate() { process.exit(7); },
};
`;

const hangPlugin = `
export default {
  meta: { name: 'hang-demo' },
  async activate(ctx) {
    await ctx.tools.register(
      { name: 'hang', description: 'hang', parameters: { type: 'object', properties: {} } },
      async () => { await new Promise(() => {}); },
    );
  },
};
`;

const capabilityPlugin = `
export default {
  meta: { name: 'cap-demo' },
  apply(ctx) { ctx.services.get('port.kv'); },
};
`;

const fsPlugin = `
export default {
  meta: { name: 'fs-demo' },
  async activate(ctx) {
    const fs = await import('node:fs');
    fs.writeFileSync('should-not-write.txt', 'x');
    await ctx.tools.register(
      { name: 'noop', description: 'noop', parameters: { type: 'object', properties: {} } },
      async (call) => ({ callId: call.id, ok: true, output: 'noop' }),
    );
  },
};
`;

test('远程插件：RemotePlugin 直接注册工具并跨进程调用', async () => {
  const dir = pluginDir('worker-demo', echoPlugin);
  const { manager, tools } = managerWithTools();
  try {
    await manager.register(
      new RemotePlugin({
        name: 'worker-demo',
        entryPath: join(dir, 'index.mjs'),
        callTimeoutMs: 5_000,
      }),
    );
    const names = tools.list().map((tool) => tool.name);
    assert.ok(names.includes('echo'), `工具表缺远程工具：${JSON.stringify(names)}`);
    const result = await tools.execute(
      { id: 'c1', name: 'echo', arguments: { text: 'hi' } },
      { sessionId: 's', workspaceRoot: dir },
    );
    assert.strictEqual(result.ok, true, result.error);
    assert.match(
      result.output ?? '',
      new RegExp(`^pid:(?!${String(process.pid)}:)`),
      '必须由子进程执行',
    );
    assert.match(result.output ?? '', /:hi$/u);
    await manager.uninstall('worker-demo');
    assert.ok(!tools.list().some((tool) => tool.name === 'echo'), '卸载后必须回收');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('远程插件：Loader 把 remote 源路由到 Worker 而非进程内 vm', async () => {
  const root = mkdtempSync(join(tmpdir(), 'omni-worker-root-'));
  pluginDir('loader-demo', echoPlugin.replace('worker-demo', 'loader-demo'), 'remote', root);
  const { manager, tools } = managerWithTools();
  const saved = process.env.OMNI_ALLOW_REMOTE_PLUGINS;
  process.env.OMNI_ALLOW_REMOTE_PLUGINS = '1';
  try {
    const loaded = await PluginLoader.loadInstalledPlugins(manager, root);
    assert.strictEqual(loaded.length, 1);
    assert.ok(manager.names().includes('loader-demo'));
    assert.ok(tools.list().some((tool) => tool.name === 'echo'));
  } finally {
    if (saved === undefined) delete process.env.OMNI_ALLOW_REMOTE_PLUGINS;
    else process.env.OMNI_ALLOW_REMOTE_PLUGINS = saved;
    await manager.uninstall('loader-demo');
    rmSync(root, { recursive: true, force: true });
  }
});

test('远程插件：legacy apply 适配器仍可注册工具', async () => {
  const dir = pluginDir('legacy-demo', legacyPlugin);
  const { manager, tools } = managerWithTools();
  try {
    await manager.register(
      new RemotePlugin({ name: 'legacy-demo', entryPath: join(dir, 'index.mjs') }),
    );
    const result = await tools.execute(
      { id: 'c2', name: 'legacy', arguments: {} },
      { sessionId: 's', workspaceRoot: dir },
    );
    assert.strictEqual(result.ok, true, result.error);
    assert.strictEqual(result.output, 'legacy-ok');
  } finally {
    await manager.uninstall('legacy-demo');
    rmSync(dir, { recursive: true, force: true });
  }
});

test('远程插件：激活崩溃被隔离，宿主存活', async () => {
  const dir = pluginDir('crash-demo', crashPlugin);
  const { manager } = managerWithTools();
  try {
    await assert.rejects(
      () =>
        manager.register(
          new RemotePlugin({ name: 'crash-demo', entryPath: join(dir, 'index.mjs') }),
        ),
      /ACTIVATION_TIMEOUT|WORKER_CRASHED/u,
    );
    assert.strictEqual(manager.isStarted('crash-demo'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('远程插件：工具超时返回失败且不拖垮宿主', async () => {
  const dir = pluginDir('hang-demo', hangPlugin);
  const { manager, tools } = managerWithTools();
  try {
    await manager.register(
      new RemotePlugin({
        name: 'hang-demo',
        entryPath: join(dir, 'index.mjs'),
        callTimeoutMs: 100,
      }),
    );
    const result = await tools.execute(
      { id: 'c3', name: 'hang', arguments: {} },
      { sessionId: 's', workspaceRoot: dir },
    );
    assert.strictEqual(result.ok, false);
    assert.match(result.error ?? '', /CALL_TIMEOUT/u);
  } finally {
    await manager.uninstall('hang-demo');
    rmSync(dir, { recursive: true, force: true });
  }
});

test('远程插件：未声明的宿主服务能力被拒绝', async () => {
  const dir = pluginDir('cap-demo', capabilityPlugin);
  const { manager } = managerWithTools();
  try {
    await assert.rejects(
      () =>
        manager.register(new RemotePlugin({ name: 'cap-demo', entryPath: join(dir, 'index.mjs') })),
      /CAPABILITY_UNAVAILABLE/u,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('远程插件：Node 权限模型拒绝 Worker 写入（纵深防御）', async () => {
  const dir = pluginDir('fs-demo', fsPlugin);
  const { manager } = managerWithTools();
  try {
    await assert.rejects(
      () =>
        manager.register(new RemotePlugin({ name: 'fs-demo', entryPath: join(dir, 'index.mjs') })),
      /ERR_ACCESS_DENIED|permission|EACCES|INVALID_FRAME/u,
    );
    assert.strictEqual(existsSync(join(dir, 'should-not-write.txt')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
