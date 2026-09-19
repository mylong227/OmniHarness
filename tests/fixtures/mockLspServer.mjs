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
//
// 全局符号（2026-09-19）：`workspace/symbol` 的语料放在独立模块 `lspWorkspaceSymbolFixture.mjs`
// （**可被测试安全 import**——本文件一旦 import 就会起一个 stdio 循环并挂住事件循环，
// 故语料不能住在这里），用真实临时目录拼 URI，不写死 `file:///repo/...`
// ——后者在 Windows 上缺盘符、不是合法 file URL。

import { WORKSPACE_SYMBOL_FIXTURE } from './lspWorkspaceSymbolFixture.mjs';

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
          capabilities: {
            definitionProvider: true,
            referencesProvider: true,
            hoverProvider: true,
            documentSymbolProvider: true,
            codeActionProvider: true,
            workspaceSymbolProvider: true,
          },
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
    // 文档符号（2026-09-19 新增）：返回**层级式** DocumentSymbol，用来验证
    // 「层级压平 + 每层两空格缩进 + 优先 selectionRange + 0-based→1-based」。
    // uri 含 `junk` ⇒ 返回一堆畸形条目，用来验证「形状不认识就跳过、绝不抛错」。
    case 'textDocument/documentSymbol': {
      const uri = msg.params.textDocument.uri;
      if (uri.includes('junk')) {
        send({
          jsonrpc: '2.0',
          id,
          result: [
            null,
            42,
            { name: 5 },
            { name: 'noRange', kind: 13 },
            { name: 'badRange', kind: 13, range: 'nope' },
            {
              name: 'good',
              kind: 13,
              selectionRange: { start: { line: 7, character: 3 }, end: { line: 7, character: 7 } },
            },
          ],
        });
        break;
      }
      send({
        jsonrpc: '2.0',
        id,
        result: [
          {
            name: 'DemoClass',
            kind: 5,
            range: { start: { line: 0, character: 0 }, end: { line: 9, character: 1 } },
            selectionRange: { start: { line: 0, character: 6 }, end: { line: 0, character: 15 } },
            children: [
              {
                name: 'fieldOne',
                kind: 8,
                range: { start: { line: 1, character: 2 }, end: { line: 1, character: 11 } },
                selectionRange: {
                  start: { line: 1, character: 2 },
                  end: { line: 1, character: 10 },
                },
              },
              {
                name: 'methodOne',
                kind: 6,
                range: { start: { line: 2, character: 2 }, end: { line: 4, character: 3 } },
                selectionRange: {
                  start: { line: 2, character: 2 },
                  end: { line: 2, character: 11 },
                },
              },
            ],
          },
          {
            name: 'topLevelFn',
            kind: 12,
            range: { start: { line: 11, character: 0 }, end: { line: 13, character: 1 } },
            selectionRange: { start: { line: 11, character: 9 }, end: { line: 11, character: 19 } },
          },
        ],
      });
      break;
    }
    // 代码操作（2026-09-19 新增）：三种上游形状各一 —— `edit.changes`、
    // 仅 `command`、`edit.documentChanges`。uri 含 `junk` ⇒ 全是畸形条目。
    case 'textDocument/codeAction': {
      const uri = msg.params.textDocument.uri;
      if (uri.includes('junk')) {
        send({
          jsonrpc: '2.0',
          id,
          result: [
            null,
            'not-an-object',
            { noTitle: true },
            { title: 'only-command', command: {} },
          ],
        });
        break;
      }
      send({
        jsonrpc: '2.0',
        id,
        result: [
          {
            title: 'Fix import',
            kind: 'quickfix',
            isPreferred: true,
            edit: {
              changes: {
                [uri]: [
                  {
                    range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } },
                    newText: "import x from 'y';",
                  },
                ],
              },
            },
          },
          { title: 'Organize imports', kind: 'source.organizeImports', command: { command: 'x' } },
          {
            title: 'Rename symbol',
            kind: 'refactor',
            edit: {
              documentChanges: [
                {
                  textDocument: { uri, version: 1 },
                  edits: [
                    {
                      range: { start: { line: 2, character: 0 }, end: { line: 2, character: 3 } },
                      newText: 'renamed',
                    },
                  ],
                },
              ],
            },
          },
        ],
      });
      break;
    }
    // 全局符号（2026-09-19 新增）：一次返回**两种上游形状**，用来验证归一化——
    //   WorkspaceSymbol（location + containerName）、WorkspaceSymbol 缺 location（无位置可报）、
    //   SymbolInformation（location + containerName）。
    // query 含 `junk` ⇒ 全是畸形条目（null / 数字 / 无名 / 无位置）。
    case 'workspace/symbol': {
      const query = typeof msg.params.query === 'string' ? msg.params.query : '';
      if (query.includes('junk')) {
        send({
          jsonrpc: '2.0',
          id,
          result: [null, 7, { name: '' }, { name: 'noLocation', kind: 12 }],
        });
        break;
      }
      send({
        jsonrpc: '2.0',
        id,
        result: WORKSPACE_SYMBOL_FIXTURE,
      });
      break;
    }
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
