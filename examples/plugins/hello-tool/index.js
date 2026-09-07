/**
 * 示例插件：注册一个 hello 工具（无敏感权限，声明 inject: ['port.tools']）。
 *
 * 用于演示「插件闭环」：市场安装 → serve 启动时自动加载（或 UI 点「重新加载」）
 * → 插件 apply 内 get('port.tools').register(...) 把 hello 工具挂进 Agent 工具表，
 * 模型即可直接调用。区别于 github-tools 等仅注册内部服务的示例。
 */
export default {
  meta: {
    name: 'hello-tool',
    inject: ['port.tools'],
  },
  apply(ctx) {
    const tools = ctx.services.get('port.tools');
    tools.register(
      {
        name: 'hello',
        description: '示例工具：回问候语（由 hello-tool 插件提供，用于验证插件闭环）',
        parameters: {
          type: 'object',
          properties: { name: { type: 'string', description: '被问候者' } },
        },
      },
      async (call) => ({
        callId: call.id,
        ok: true,
        output: `hello, ${typeof call.arguments.name === 'string' && call.arguments.name.length > 0 ? call.arguments.name : 'world'}!`,
      }),
    );
  },
};
