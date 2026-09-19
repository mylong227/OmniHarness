// 全局符号（`workspace/symbol`）测试语料：**独立模块**，供 mock LSP 服务器与单测共享同一份事实。
//
// 为什么单独成文件：mockLspServer.mjs 一被 import 就会挂上 stdin 循环并钉住事件循环
// （它是给子进程用的），测试进程不能 import 它。而「期望路径」与「mock 返回的 URI」
// 必须是同一份事实，否则两边各抄一份字面量、改一处漏一处。
//
// URI 由**真实临时目录**拼出（pathToFileURL）：写死 `file:///repo/...` 在 Windows 上缺盘符、
// 不是合法 file URL，uriToFile 会抛 ERR_INVALID_FILE_URL_PATH。

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** 假仓库根（真实存在，保证拼出的 file URL 在任意平台都合法）。 */
export const REPO_ROOT = mkdtempSync(join(tmpdir(), 'omni-lsp-mock-repo-'));

/** 文件系统路径 → file:// URI。 */
const uriOf = (rel) => pathToFileURL(join(REPO_ROOT, rel)).href;

/** 测试侧断言用的期望路径。 */
export const WORKSPACE_SYMBOL_PATHS = {
  repoRoot: REPO_ROOT,
  srcDir: join(REPO_ROOT, 'src'),
  demoFile: join(REPO_ROOT, 'src', 'demo.ts'),
  utilFile: join(REPO_ROOT, 'src', 'util.ts'),
};

/**
 * `workspace/symbol` 的固定返回：一次覆盖两种上游形状 + 一条缺位置。
 *  ① WorkspaceSymbol（location + containerName）；
 *  ② WorkspaceSymbol 缺 location（LSP 3.17 允许，适配器须用查询串占位而不是丢结果）；
 *  ③ SymbolInformation（location + 空白 containerName，须被省略）。
 */
export const WORKSPACE_SYMBOL_FIXTURE = [
  {
    name: 'DemoClass',
    kind: 5,
    containerName: 'demo',
    location: {
      uri: uriOf('src/demo.ts'),
      range: { start: { line: 9, character: 6 }, end: { line: 9, character: 15 } },
    },
  },
  { name: 'dirOnly', kind: 2, location: { uri: uriOf('src') } },
  // 非 file:// 的 URI（虚拟文档）且没给区间 ⇒ 转不成文件路径，**跳过**而不是报一个假文件。
  { name: 'untitled', kind: 12, location: { uri: 'untitled:Untitled-1' } },
  // 真正畸形的一条（连 URI 都没有 ⇒ 无文件可报），钉住「跳过而不是抛错」。
  { name: 'noLocation', kind: 12 },
  {
    name: 'topLevelFn',
    kind: 12,
    location: {
      uri: uriOf('src/demo.ts'),
      range: { start: { line: 20, character: 9 }, end: { line: 20, character: 19 } },
    },
    containerName: '',
  },
  {
    name: 'helper',
    kind: 12,
    location: {
      uri: uriOf('src/util.ts'),
      range: { start: { line: 2, character: 0 }, end: { line: 2, character: 6 } },
    },
    containerName: 'Util',
  },
];
