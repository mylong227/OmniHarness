// Mock LSP 服务器：仅供 OmniHarness 的 LspProcessAdapter 集成测试使用。
// 它实现最小 LSP 子集（initialize / definition / references / hover / shutdown），
// 通过 stdio + Content-Length 分帧的 JSON-RPC 2.0 通信，不依赖任何真实语言服务器。
// 注意：坐标系用 LSP 0-based（与适配器发来的请求一致）；返回的 line 0 经适配器转回 1-based。

let buffer = Buffer.alloc(0);

function send(msg) {
  const json = JSON.stringify(msg);
  const payload = Buffer.from(json, 'utf8');
  process.stdout.write(`Content-Length: ${payload.length}\r\n\r\n`);
  process.stdout.write(payload);
}

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd === -1) break;
    const header = buffer.subarray(0, headerEnd).toString('utf8');
    const match = /Content-Length:\s*(\d+)/i.exec(header);
    if (match === null || match[1] === undefined) {
      buffer = buffer.subarray(1);
      continue;
    }
    const length = Number(match[1]);
    const bodyStart = headerEnd + 4;
    if (buffer.length < bodyStart + length) break;
    const body = buffer.subarray(bodyStart, bodyStart + length).toString('utf8');
    buffer = buffer.subarray(bodyStart + length);
    let msg;
    try {
      msg = JSON.parse(body);
    } catch {
      continue;
    }
    handle(msg);
  }
});

function handle(msg) {
  // 通知（无 id）：initialized / didOpen / exit 等。
  if (msg.id === undefined) {
    if (msg.method === 'exit') process.exit(0);
    return;
  }
  const id = msg.id;
  switch (msg.method) {
    case 'initialize':
      send({
        jsonrpc: '2.0',
        id,
        result: {
          capabilities: { definitionProvider: true, referencesProvider: true, hoverProvider: true },
        },
      });
      break;
    case 'textDocument/definition':
      // 无视 position，固定返回文件 line 1（0-based line 0）一处定义。
      send({
        jsonrpc: '2.0',
        id,
        result: {
          uri: msg.params.textDocument.uri,
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 8 } },
        },
      });
      break;
    case 'textDocument/references': {
      const uri = msg.params.textDocument.uri;
      send({
        jsonrpc: '2.0',
        id,
        result: [
          { uri, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } } },
          { uri, range: { start: { line: 2, character: 0 }, end: { line: 2, character: 4 } } },
        ],
      });
      break;
    }
    case 'textDocument/hover':
      send({
        jsonrpc: '2.0',
        id,
        result: { contents: { kind: 'plaintext', value: 'mock hover doc for symbol' } },
      });
      break;
    case 'shutdown':
      send({ jsonrpc: '2.0', id, result: null });
      break;
    default:
      send({
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `method not found: ${msg.method}` },
      });
  }
}
