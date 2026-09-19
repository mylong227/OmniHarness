// Mock LSP 服务器：仅供 OmniHarness 的 LspProcessAdapter 集成测试使用。
// 它实现最小 LSP 子集（initialize / definition / references / hover / shutdown / publishDiagnostics），
// 通过 stdio + Content-Length 分帧的 JSON-RPC 2.0 通信，不依赖任何真实语言服务器。
// 注意：坐标系用 LSP 0-based（与适配器发来的请求一致）；返回的 line 0 经适配器转回 1-based。
//
// 诊断（2026-09-19）：`textDocument/didOpen` / `didChange` 后**主动推送** publishDiagnostics，
// 据此可端到端验证「通知被订阅 → 缓存 → 归一化 → 状态判定」整条链路。
// 推送内容由文档文本决定，便于测试双向断言：
//   - 文本含 `LSP_OK`  ⇒ 推送空数组（无诊断）；
//   - 否则            ⇒ 推送 1 条 error + 1 条 warning（0-based 行 4 / 1）。

let buffer = Buffer.alloc(0);

function send(msg) {
  const json = JSON.stringify(msg);
  const payload = Buffer.from(json, 'utf8');
  process.stdout.write(`Content-Length: ${payload.length}\r\n\r\n`);
  process.stdout.write(payload);
}

/** 按文档文本推送诊断（空数组 = 该文件无问题）。 */
function publishDiagnostics(uri, text) {
  const clean = typeof text === 'string' && text.includes('LSP_OK');
  send({
    jsonrpc: '2.0',
    method: 'textDocument/publishDiagnostics',
    params: {
      uri,
      diagnostics: clean
        ? []
        : [
            {
              range: { start: { line: 4, character: 2 }, end: { line: 4, character: 9 } },
              severity: 1,
              code: 2304,
              source: 'mock-ts',
              message: "Cannot find name 'missingSymbol'.",
            },
            {
              range: { start: { line: 1, character: 0 }, end: { line: 1, character: 3 } },
              severity: 2,
              source: 'mock-ts',
              message: 'Unused variable.',
            },
          ],
    },
  });
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
  // 通知（无 id）：initialized / didOpen / didChange / exit 等。
  if (msg.id === undefined) {
    if (msg.method === 'exit') process.exit(0);
    if (msg.method === 'textDocument/didOpen' || msg.method === 'textDocument/didChange') {
      const uri =
        msg.method === 'textDocument/didOpen'
          ? msg.params.textDocument.uri
          : msg.params.textDocument.uri;
      const text =
        msg.method === 'textDocument/didOpen'
          ? msg.params.textDocument.text
          : (msg.params.contentChanges?.[0]?.text ?? '');
      publishDiagnostics(uri, text);
    }
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
