/**
 * 微型插件闭环 demo（自包含，零依赖，可直接 node 运行）
 *
 * 用 30 行模拟 OmniHarness 的插件闭环：
 *   manifest 元信息 → apply 里经 port.tools 注册工具 → 模型可调用 → effect 卸载清理。
 * 真正的插件请参考 examples/plugins/hello-tool/（带 omni.plugin.json 的完整形态）。
 */

// ---- 1. 极简 port.tools 服务（真实系统里是 RegistryToolPort）----
const tools = {
  registry: new Map(),
  register(def, handler) {
    this.registry.set(def.name, { def, handler });
    console.log(`[port.tools] 工具已注册: ${def.name} — ${def.description}`);
  },
  unregister(name) {
    this.registry.delete(name);
    console.log(`[port.tools] 工具已卸载: ${name}`);
  },
  async invoke(name, args) {
    const t = this.registry.get(name);
    if (!t) throw new Error(`unknown tool: ${name}`);
    const r = await t.handler({
      id: `call_${Math.random().toString(36).slice(2, 8)}`,
      arguments: args,
    });
    return r;
  },
};

// ---- 2. 定义一个小插件（类比 hello-tool）----
const helloPlugin = {
  meta: { name: 'hello-tool', inject: ['port.tools'] },
  async apply(ctx) {
    const tools = ctx.services.get('port.tools');
    tools.register(
      { name: 'hello', description: '回问候语', parameters: { type: 'object' } },
      async (call) => ({
        callId: call.id,
        ok: true,
        output: `hello, ${call.arguments.name ?? 'world'}!`,
      }),
    );
  },
  async effect() {}, // 无外部资源，占位
};

// ---- 3. 模拟运行时：按 meta.inject 装配上下文并 apply ----
const services = new Map([['port.tools', tools]]);
await helloPlugin.apply({ services }); // 插件启动，工具挂进工具表

// ---- 4. 模拟模型发起一次工具调用 ----
const result = await tools.invoke('hello', { name: 'OmniHarness' });
console.log(`[agent] 调用结果: ok=${result.ok} output="${result.output}"`);

// ---- 5. 卸载清理 ----
await helloPlugin.effect();
tools.unregister('hello');

console.log('\n✅ 闭环演示完毕。');
