import { test } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Container } from '../../src/core/container.ts';
import { PluginManager } from '../../src/plugin/pluginManager.ts';
import { PermissionGate } from '../../src/plugin/permissionGate.ts';
import { PluginLoader } from '../../src/plugin/pluginLoader.ts';
import { RemotePlugin } from '../../src/plugin/worker/remotePlugin.ts';
import { RegistryToolPort } from '../../src/adapters/tool/registryToolPort.ts';
import { WindowsAclSandbox } from '../../src/adapters/sandbox/windowsAclSandbox.ts';
import { PluginWorkerMetrics } from '../../src/plugin/worker/pluginWorkerMetrics.ts';

// 既有判据多数直接构造 RemotePlugin 且不注入沙箱；显式关闭强制沙箱，专门的判据会单独验证默认强制。
process.env['OMNI_PLUGIN_REQUIRE_OS_SANDBOX'] = '0';

/** 清理临时插件目录；Windows 上 worker 退出后仍可能短暂持有 cwd，清理失败不该让判据假红。 */
function cleanup(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    /* 留给 OS 临时目录清理 */
  }
}

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

const fsReadPlugin = `
export default {
  meta: { name: 'fs-read' },
  async activate(ctx) {
    const result = await ctx.call('fs', 'read', { path: 'secret.txt' });
    await ctx.tools.register(
      { name: 'read', description: 'read', parameters: { type: 'object', properties: {} } },
      async (call) => ({ callId: call.id, ok: true, output: result.text }),
    );
  },
};
`;

const fsWritePlugin = `
export default {
  meta: { name: 'fs-write' },
  async activate(ctx) {
    await ctx.call('fs', 'write', { path: 'nested/out.txt', text: 'written-by-worker' });
    await ctx.tools.register(
      { name: 'write', description: 'write', parameters: { type: 'object', properties: {} } },
      async (call) => ({ callId: call.id, ok: true, output: 'ok' }),
    );
  },
};
`;

const crashToolPlugin = `
export default {
  meta: { name: 'crash-tool' },
  async activate(ctx) {
    await ctx.tools.register(
      { name: 'echo', description: 'echo', parameters: { type: 'object', properties: {} } },
      async (call) => ({ callId: call.id, ok: true, output: 'ok' }),
    );
    await ctx.tools.register(
      { name: 'crash', description: 'crash', parameters: { type: 'object', properties: {} } },
      async () => { process.exit(7); },
    );
  },
};
`;

test('远程插件：默认强制 OS 沙箱，缺 wrap 时拒绝启动', async () => {
  const saved = process.env['OMNI_PLUGIN_REQUIRE_OS_SANDBOX'];
  delete process.env['OMNI_PLUGIN_REQUIRE_OS_SANDBOX'];
  const dir = pluginDir('sandbox-required', echoPlugin);
  const { manager } = managerWithTools();
  try {
    await assert.rejects(
      () =>
        manager.register(
          new RemotePlugin({ name: 'sandbox-required', entryPath: join(dir, 'index.mjs') }),
        ),
      /SANDBOX_UNAVAILABLE/u,
    );
  } finally {
    process.env['OMNI_PLUGIN_REQUIRE_OS_SANDBOX'] = saved ?? '0';
    cleanup(dir);
  }
});

test('远程插件：Worker 运行期崩溃后退避重启并恢复工具', async () => {
  PluginWorkerMetrics.reset();
  const dir = pluginDir('crash-tool', crashToolPlugin);
  const { manager, tools } = managerWithTools();
  try {
    await manager.register(
      new RemotePlugin({
        name: 'crash-tool',
        entryPath: join(dir, 'index.mjs'),
        workspaceRoot: dir,
        restart: { maxAttempts: 5, baseDelayMs: 5 },
      }),
    );
    const crashed = await tools.execute(
      { id: 'c-crash', name: 'crash', arguments: {} },
      { sessionId: 's', workspaceRoot: dir },
    );
    assert.strictEqual(crashed.ok, false);
    const recovered = await tools.execute(
      { id: 'c-echo', name: 'echo', arguments: {} },
      { sessionId: 's', workspaceRoot: dir },
    );
    assert.strictEqual(recovered.ok, true, recovered.error);
    const metrics = PluginWorkerMetrics.snapshot('crash-tool');
    assert.ok(metrics.activations >= 2, `应至少重启一次，实际 ${JSON.stringify(metrics)}`);
    assert.ok(metrics.crashes >= 1, `应记录崩溃，实际 ${JSON.stringify(metrics)}`);
  } finally {
    await manager.uninstall('crash-tool');
    cleanup(dir);
  }
});

test('远程插件：RemotePlugin 直接注册工具并跨进程调用', async () => {
  PluginWorkerMetrics.reset();
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
    assert.deepStrictEqual(PluginWorkerMetrics.snapshot('worker-demo'), {
      activations: 1,
      calls: 1,
      failures: 0,
      crashes: 0,
    });
    await manager.uninstall('worker-demo');
    assert.ok(!tools.list().some((tool) => tool.name === 'echo'), '卸载后必须回收');
  } finally {
    cleanup(dir);
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
    cleanup(root);
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
    cleanup(dir);
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
    cleanup(dir);
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
    cleanup(dir);
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
    cleanup(dir);
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
    try {
      cleanup(dir);
    } catch {
      /* 进程仍持有 cwd 时留给 OS 临时目录清理；判据不因清理失败而假红 */
    }
  }
});

test('远程插件：声明 fs.read 后可经能力 broker 读取工作区文件', async () => {
  const dir = pluginDir('fs-read', fsReadPlugin);
  writeFileSync(join(dir, 'secret.txt'), 'broker-secret', 'utf8');
  const { manager, tools } = managerWithTools();
  try {
    await manager.register(
      new RemotePlugin({
        name: 'fs-read',
        entryPath: join(dir, 'index.mjs'),
        workspaceRoot: dir,
        permissions: ['fs.read'],
      }),
    );
    const result = await tools.execute(
      { id: 'c4', name: 'read', arguments: {} },
      { sessionId: 's', workspaceRoot: dir },
    );
    assert.strictEqual(result.ok, true, result.error);
    assert.strictEqual(result.output, 'broker-secret');
  } finally {
    await manager.uninstall('fs-read');
    cleanup(dir);
  }
});

test('远程插件：声明 fs.write 后可经能力 broker 写入工作区', async () => {
  const dir = pluginDir('fs-write', fsWritePlugin);
  const { manager, tools } = managerWithTools();
  try {
    await manager.register(
      new RemotePlugin({
        name: 'fs-write',
        entryPath: join(dir, 'index.mjs'),
        workspaceRoot: dir,
        permissions: ['fs.write'],
      }),
    );
    const result = await tools.execute(
      { id: 'c5', name: 'write', arguments: {} },
      { sessionId: 's', workspaceRoot: dir },
    );
    assert.strictEqual(result.ok, true, result.error);
    assert.strictEqual(readFileSync(join(dir, 'nested', 'out.txt'), 'utf8'), 'written-by-worker');
  } finally {
    await manager.uninstall('fs-write');
    cleanup(dir);
  }
});

test('远程插件：未声明 fs.read 时能力 broker 拒绝', async () => {
  const dir = pluginDir('fs-read-denied', fsReadPlugin.replace('fs-read', 'fs-read-denied'));
  writeFileSync(join(dir, 'secret.txt'), 'broker-secret', 'utf8');
  const { manager } = managerWithTools();
  try {
    await assert.rejects(
      () =>
        manager.register(
          new RemotePlugin({
            name: 'fs-read-denied',
            entryPath: join(dir, 'index.mjs'),
            workspaceRoot: dir,
            permissions: [],
          }),
        ),
      /UNAUTHORIZED_CAPABILITY/u,
    );
  } finally {
    cleanup(dir);
  }
});

test('远程插件：配置 OS 沙箱后 Worker 仍可启动并执行工具（Windows ACL）', async () => {
  if (process.platform !== 'win32') return;
  const root = mkdtempSync(join(tmpdir(), 'omni-worker-acl-'));
  const plugin = pluginDir(
    'acl-demo',
    echoPlugin.replace('worker-demo', 'acl-demo'),
    'remote',
    root,
  );
  const { manager, tools } = managerWithTools();
  try {
    const sandbox = new WindowsAclSandbox(root, 'read-only');
    await manager.register(
      new RemotePlugin({
        name: 'acl-demo',
        entryPath: join(plugin, 'index.mjs'),
        workspaceRoot: root,
        sandbox,
      }),
    );
    const result = await tools.execute(
      { id: 'c5', name: 'echo', arguments: { text: 'acl' } },
      { sessionId: 's', workspaceRoot: root },
    );
    assert.strictEqual(result.ok, true, result.error);
    assert.match(result.output ?? '', /:acl$/u);
  } finally {
    await manager.uninstall('acl-demo');
    cleanup(root);
  }
}, 120_000);
