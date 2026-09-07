import type { Plugin } from '../src/plugin/plugin.js';
import { RegistryToolPort } from '../src/adapters/tool/registryToolPort.js';
import type { ToolCall, ToolContext, ToolDefinition, ToolResult } from '../src/ports/tool.js';

/** 示例插件：依赖 port.tools 服务，就绪后注册一个 ping 工具；卸载时清理。 */
const plugin: Plugin = {
  meta: {
    name: 'sample-tools',
    inject: ['port.tools'],
  },
  async apply(context) {
    const tools = context.services.get<RegistryToolPort>('port.tools');
    const definition: ToolDefinition = {
      name: 'ping',
      description: '返回 pong（示例插件工具）',
      parameters: { type: 'object', properties: {} },
    };
    const handler = async (call: ToolCall, _ctx: ToolContext): Promise<ToolResult> => ({
      callId: call.id,
      ok: true,
      output: 'pong',
    });
    tools.register(definition, handler);
    context.registerService('tool.ping', handler);
  },
  async effect() {
    // 清理：示例中无外部资源，仅占位
  },
};

export default plugin;
