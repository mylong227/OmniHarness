// 示例插件：仅由离线 catalog（examples/catalog/registry.json）提供，
// 用于验证 FileRegistrySource 端到端可用。注册一个工具 notes_echo。
const plugin = {
  meta: {
    name: 'demo-notes',
    version: '0.1.0',
    description: '离线 catalog 示例：notes_echo 工具',
    permissions: ['fs.read'],
    inject: ['port.tools'],
  },
  apply(context) {
    const tools = context.services.get('port.tools');
    tools.register(
      {
        name: 'notes_echo',
        description: '回显并反转传入文本（示例工具，验证文件型 registry 插件注入）',
        parameters: {
          type: 'object',
          properties: { text: { type: 'string', description: '待回显文本' } },
          required: ['text'],
        },
      },
      async (args) => {
        const text = typeof args?.text === 'string' ? args.text : '';
        return { echoed: text, reversed: [...text].reverse().join('') };
      },
    );
  },
};

export default plugin;
