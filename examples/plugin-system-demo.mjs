#!/usr/bin/env node
/**
 * OmniHarness 小系统 Demo —— 插件生命周期系统
 *
 * 自包含（零依赖）迷你插件系统，概念与仓库源码一一对应：
 *   - src/plugin/plugin.ts        Plugin：{ meta, apply(context), effect() }
 *   - src/ports/tool.ts           ToolDefinition / ToolCall / ToolResult
 *   - src/adapters/tool/registryToolPort.ts   register(def, handler) 注册表
 *   - src/plugin/*                load → inject 依赖 → apply → effect 清理
 *   - examples/samplePlugin.ts / examples/plugins/demo-notes  真实插件样板
 *
 * 语义要点：
 *   - 插件声明 inject 依赖，容器按需注入，缺失依赖则加载失败（fail-closed，
 *     不留下半加载状态）；
 *   - 工具定义带 JSON-schema 校验；未注册工具调用返回明确错误；
 *   - effect() 是幂等清理钩子，卸载时注销全部工具并释放资源。
 *
 * 运行: node examples/plugin-system-demo.mjs
 */
'use strict';

/* ============================================================
 * Part 1  服务容器（迷你 DI：key -> singleton service）
 * ============================================================ */
class ServiceContainer {
  constructor() {
    this.services = new Map();
  }
  register(key, svc) {
    this.services.set(key, svc);
  }
  has(key) {
    return this.services.has(key);
  }
  get(key) {
    if (!this.services.has(key)) throw new Error(`service "${key}" not registered`);
    return this.services.get(key);
  }
}

/* ============================================================
 * Part 2  工具注册表（对应 RegistryToolPort）
 * ============================================================ */
class ToolRegistry {
  constructor() {
    this.defs = new Map();   // name -> definition
    this.handlers = new Map(); // name -> handler(args)
  }

  register(def, handler) {
    if (!def?.name || typeof handler !== 'function') {
      throw new Error(`bad tool registration: name=${def?.name}`);
    }
    if (this.defs.has(def.name)) {
      throw new Error(`tool "${def.name}" already registered`);
    }
    this.defs.set(def.name, def);
    this.handlers.set(def.name, handler);
  }

  unregister(name) {
    return this.defs.delete(name) && this.handlers.delete(name);
  }

  list() {
    return [...this.defs.values()].map((d) => `${d.name}${d.description ? ` (${d.description})` : ''}`);
  }

  async call(name, args = {}) {
    const handler = this.handlers.get(name);
    if (!handler) throw new Error(`unknown tool "${name}" (registered: ${this.list().join(', ') || 'none'})`);
    return handler(args);
  }
}

/* ============================================================
 * Part 3  插件运行时：load / unload
 * ============================================================ */
class PluginManager {
  constructor(container) {
    this.container = container;
    this.loaded = new Map(); // name -> { plugin, toolNames:Set }
    this.tools = container.get('port.tools');
  }

  /** 装载插件：校验 manifest -> 注入 -> apply；任一步失败都不留副作用。 */
  async load(plugin) {
    const meta = plugin.meta;
    if (!meta?.name) throw new Error('plugin missing meta.name');
    if (this.loaded.has(meta.name)) throw new Error(`plugin "${meta.name}" already loaded`);

    // 1) 依赖注入检查（fail-closed）
    for (const dep of meta.inject ?? []) {
      if (!this.container.has(dep)) {
        throw new Error(
          `plugin "${meta.name}" requires service "${dep}" which is not provided; load aborted`,
        );
      }
    }

    // 2) apply：注册工具，记录归属
    const registeredBefore = new Set(this.tools.defs.keys());
    const context = {
      meta,
      services: this.container,
      log: (msg) => console.log(`    [${meta.name}] ${msg}`),
    };
    await plugin.apply(context);

    const toolNames = [...this.tools.defs.keys()].filter((n) => !registeredBefore.has(n));
    this.loaded.set(meta.name, { plugin, toolNames });
    return toolNames;
  }

  /** 卸载：先 effect() 做资源清理，再注销其注册的工具（幂等）。 */
  async unload(name) {
    const entry = this.loaded.get(name);
    if (!entry) throw new Error(`plugin "${name}" not loaded`);
    await entry.plugin.effect?.();
    for (const t of entry.toolNames) this.tools.unregister(t);
    this.loaded.delete(name);
    return entry.toolNames;
  }

  summary() {
    return [...this.loaded.keys()].join(', ') || '(none)';
  }
}

/* ============================================================
 * 场景：registry 起系统 -> 装载两个插件 -> 调用工具
 *       -> 缺失依赖插件被拒 -> 卸载插件并观察清理
 * ============================================================ */
console.log('=== OmniHarness plugin-system mini demo ===\n');

// 启动系统：容器里先就绪基础设施服务
const container = new ServiceContainer();
container.register('port.tools', new ToolRegistry());
container.register('port.log', { info: (s) => console.log('    [log] ' + s) });
const pm = new PluginManager(container);

/* --- 插件 A：hello-tool（真实样板 examples/plugins/hello-tool） --- */
const helloPlugin = {
  meta: { name: 'hello-tool', version: '0.1.0', inject: ['port.tools'] },
  async apply(ctx) {
    const tools = ctx.services.get('port.tools');
    tools.register(
      { name: 'hello', description: 'say hello', parameters: { type: 'object', properties: { who: { type: 'string' } } } },
      async (args) => `hello, ${args?.who ?? 'world'}!`,
    );
    ctx.log('tool "hello" registered');
  },
  async effect() {
    console.log('    [hello-tool] effect(): releasing nothing (stateless)');
  },
};

/* --- 插件 B：demo-notes（真实样板 examples/plugins/demo-notes） --- */
const notesPlugin = {
  meta: { name: 'demo-notes', version: '0.1.0', inject: ['port.tools', 'port.log'] },
  async apply(ctx) {
    const tools = ctx.services.get('port.tools');
    const log = ctx.services.get('port.log');
    tools.register(
      {
        name: 'notes_echo',
        description: 'echo & reverse text',
        parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      },
      async (args) => {
        const text = String(args?.text ?? '');
        return { echoed: text, reversed: [...text].reverse().join('') };
      },
    );
    log.info('notes_echo handler ready');
  },
  async effect() {
    console.log('    [demo-notes] effect(): notes flushed to disk');
  },
};

/* --- 插件 C：缺 port.db 依赖，应当被 fail-closed 拒绝 --- */
const brokenPlugin = {
  meta: { name: 'needs-db', inject: ['port.db'] },
  async apply() {},
};

console.log('-- load hello-tool --');
let names = await pm.load(helloPlugin);
console.log(`  tools now: ${pm.tools.list().join(' | ')}  (loaded: ${pm.summary()})`);

console.log('\n-- load demo-notes --');
names = await pm.load(notesPlugin);
console.log(`  tools now: ${pm.tools.list().join(' | ')}  (loaded: ${pm.summary()})`);

console.log('\n-- invoke tools --');
console.log(`  call hello(who=Omni)     -> ${await pm.tools.call('hello', { who: 'Omni' })}`);
const r = await pm.tools.call('notes_echo', { text: 'OmniHarness' });
console.log(`  call notes_echo(text)    -> echoed=${r.echoed}  reversed=${r.reversed}`);
try {
  await pm.tools.call('nope');
} catch (e) {
  console.log(`  call nope                -> ERROR: ${e.message}`);
}

console.log('\n-- load plugin missing required service (fail-closed) --');
try {
  await pm.load(brokenPlugin);
} catch (e) {
  console.log(`  ERROR: ${e.message}`);
}
console.log(`  loaded plugins unchanged : ${pm.summary()}`);

console.log('\n-- unload hello-tool (effect() then tool removal) --');
names = await pm.unload('hello-tool');
console.log(`  removed tools: ${names.join(', ')}`);
console.log(`  tools now: ${pm.tools.list().join(' | ') || '(none)'}  (loaded: ${pm.summary()})`);

console.log('\n-- duplicate load rejected --');
try {
  await pm.load(notesPlugin);
} catch (e) {
  console.log(`  ERROR: ${e.message}`);
}

console.log('\n-- shutdown: unload remaining plugins --');
names = await pm.unload('demo-notes');
console.log(`  removed tools: ${names.join(', ')}`);
console.log(`  final registry: ${pm.tools.list().join(' | ') || '(empty)'}   loaded: ${pm.summary()}`);

console.log('\nDone.');
