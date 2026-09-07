import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Container } from '../../src/core/container.js';
import { PluginManager } from '../../src/plugin/pluginManager.js';
import { RegistryToolPort } from '../../src/adapters/tool/registryToolPort.js';
import type { Plugin, PluginApplyContext } from '../../src/plugin/plugin.js';
import type { ToolDefinition } from '../../src/ports/tool.js';
import type { ToolHandler } from '../../src/adapters/tool/toolHandler.js';

/** 记录调用序列。 */
interface Trace {
  readonly log: string[];
}

/** 构造简单插件。 */
function simplePlugin(name: string, trace: Trace, inject?: readonly string[]): Plugin {
  return {
    meta: { name, inject },
    apply(_context: PluginApplyContext): void {
      trace.log.push(`apply:${name}`);
    },
    effect(): void {
      trace.log.push(`effect:${name}`);
    },
  };
}

test('插件：注册后立即启动（无依赖）', async () => {
  const trace: Trace = { log: [] };
  const manager = new PluginManager(new Container());
  await manager.register(simplePlugin('a', trace));
  assert.deepStrictEqual(trace.log, ['apply:a']);
  assert.strictEqual(manager.isStarted('a'), true);
});

test('插件：依赖未就绪不启动，服务注册后自动启动', async () => {
  const trace: Trace = { log: [] };
  const manager = new PluginManager(new Container());
  await manager.register(simplePlugin('b', trace, ['port.tools']));
  assert.deepStrictEqual(trace.log, [], '依赖缺失不应启动');
  assert.strictEqual(manager.isStarted('b'), false);

  await manager.registerService('port.tools', {});
  assert.deepStrictEqual(trace.log, ['apply:b'], '服务就绪后应自动启动');
});

test('插件：卸载执行 effect 且不再启动', async () => {
  const trace: Trace = { log: [] };
  const manager = new PluginManager(new Container());
  await manager.register(simplePlugin('c', trace));
  await manager.uninstall('c');
  assert.deepStrictEqual(trace.log, ['apply:c', 'effect:c']);
  assert.strictEqual(manager.isStarted('c'), false);
  assert.deepStrictEqual(manager.names(), []);
});

test('插件：重复注册抛错', async () => {
  const manager = new PluginManager(new Container());
  await manager.register(simplePlugin('dup', { log: [] }));
  await assert.rejects(() => manager.register(simplePlugin('dup', { log: [] })), /重复注册/);
});

test('插件：onService 订阅已注册服务立即回调', async () => {
  const container = new Container();
  container.register('s', 42);
  const manager = new PluginManager(container);
  let received: unknown;
  await manager.register({
    meta: { name: 'sub' },
    apply(context: PluginApplyContext): void {
      context.onService('s', (service) => {
        received = service;
      });
    },
  });
  assert.strictEqual(received, 42);
});

test('插件：onService 订阅未注册服务，注册后回调', async () => {
  const manager = new PluginManager(new Container());
  let received: unknown;
  await manager.register({
    meta: { name: 'late' },
    apply(context: PluginApplyContext): void {
      context.onService('late-svc', (service) => {
        received = service;
      });
    },
  });
  assert.strictEqual(received, undefined);
  await manager.register({
    meta: { name: 'provider' },
    apply(context: PluginApplyContext): void {
      context.registerService('late-svc', 'hello');
    },
  });
  assert.strictEqual(received, 'hello');
});

test('插件：插件注册服务可触发依赖方启动', async () => {
  const trace: Trace = { log: [] };
  const manager = new PluginManager(new Container());
  await manager.register({
    meta: { name: 'provider' },
    apply(context: PluginApplyContext): void {
      context.registerService('svc.x', 'x');
      trace.log.push('apply:provider');
    },
  });
  await manager.register(simplePlugin('consumer', trace, ['svc.x']));
  assert.deepStrictEqual(trace.log, ['apply:provider', 'apply:consumer']);
});

test('插件：启动快照工具增量，卸载精准回收（无孤儿工具残留）', async () => {
  const container = new Container();
  const tools = new RegistryToolPort();
  container.register('port.tools', tools);
  const manager = new PluginManager(container);

  const def: ToolDefinition = {
    name: 'demo_tool',
    description: 'd',
    parameters: { type: 'object', properties: {}, required: [] },
  };
  const handler: ToolHandler = async () => ({ callId: 'x', ok: true, output: 'ok' });

  await manager.register({
    meta: { name: 'toolPlugin' },
    apply(context: PluginApplyContext): void {
      const tp = context.services.get('port.tools') as RegistryToolPort;
      tp.register(def, handler);
    },
  });
  assert.ok(
    tools.list().some((t) => t.name === 'demo_tool'),
    '工具应在启动后注册',
  );

  await manager.uninstall('toolPlugin');
  assert.ok(!tools.list().some((t) => t.name === 'demo_tool'), '工具应在卸载后被回收');
});
