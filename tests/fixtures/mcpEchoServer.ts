import { createInterface } from 'node:readline';

/**
 * 测试夹具：最小 MCP 服务器（stdio 行式 JSON-RPC）。
 * 暴露两个工具：echo（回显 text）、boom（故意失败），用于网关端到端测试。
 */
const tools = [
  {
    name: 'echo',
    description: '回显输入文本',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
  {
    name: 'boom',
    description: '故意失败的工具',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
];

/** 处理单条请求并返回响应体。 */
function resolve(message: Record<string, unknown>): Record<string, unknown> {
  const method = String(message['method'] ?? '');
  const id = message['id'] ?? 0;
  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'fixture', version: '1.0.0' },
      },
    };
  }
  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools } };
  }
  if (method === 'tools/call') {
    const params = (message['params'] ?? {}) as Record<string, unknown>;
    const name = String(params['name'] ?? '');
    const args = (params['arguments'] ?? {}) as Record<string, unknown>;
    if (name === 'echo') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: `echo:${String(args['text'] ?? '')}` }],
          isError: false,
        },
      };
    }
    if (name === 'boom') {
      return {
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: 'boom 失败' }], isError: true },
      };
    }
    return { jsonrpc: '2.0', id, error: { code: -32601, message: `未知工具: ${name}` } };
  }
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `方法不存在: ${method}` } };
}

const reader = createInterface({ input: process.stdin, crlfDelay: Infinity });
reader.on('line', (line) => {
  if (line.trim() === '') {
    return;
  }
  process.stdout.write(`${JSON.stringify(resolve(JSON.parse(line) as Record<string, unknown>))}\n`);
});
