// 桶文件：保留原 `src/ports/tool/lsp.ts` 的全部导出，调用点零改动。
// 每个接口已拆分为 `./lsp/<接口名>.ts`（一接口一文件，见 docs/archive/INTERFACE_REFACTOR_QUEUE.md Batch A）。

export type { LspPosition } from './lsp/lspPosition.js';
export type { LspRange } from './lsp/lspRange.js';
export type { LspLocation } from './lsp/lspLocation.js';
export type { LspDiagnosticSeverity } from './lsp/lspDiagnosticSeverity.js';
export type { LspDiagnostic } from './lsp/lspDiagnostic.js';
export type { LspDiagnosticReport } from './lsp/lspDiagnosticReport.js';
export type { LspServerConfig } from './lsp/lspServerConfig.js';
export type { LspSymbolKind } from './lsp/lspSymbolKind.js';
export type { LspSymbol } from './lsp/lspSymbol.js';
export type { LspWorkspaceSymbol } from './lsp/lspWorkspaceSymbol.js';
export type { LspTextEdit } from './lsp/lspTextEdit.js';
export type { LspCodeAction } from './lsp/lspCodeAction.js';
export type { LspPort } from './lsp/lspPort.js';
