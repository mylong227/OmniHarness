// 桶文件：保留原 `src/ports/tool/lsp.ts` 的全部导出，调用点零改动。
// 每个接口已拆分为 `./lsp/<接口名>.ts`（一接口一文件，见 docs/archive/INTERFACE_REFACTOR_QUEUE.md Batch A）。

export type { LspPosition } from './lsp/lspPosition.ts';
export type { LspRange } from './lsp/lspRange.ts';
export type { LspLocation } from './lsp/lspLocation.ts';
export type { LspDiagnosticSeverity } from './lsp/lspDiagnosticSeverity.ts';
export type { LspDiagnostic } from './lsp/lspDiagnostic.ts';
export type { LspDiagnosticReport } from './lsp/lspDiagnosticReport.ts';
export type { LspServerConfig } from './lsp/lspServerConfig.ts';
export type { LspSymbolKind } from './lsp/lspSymbolKind.ts';
export type { LspSymbol } from './lsp/lspSymbol.ts';
export type { LspWorkspaceSymbol } from './lsp/lspWorkspaceSymbol.ts';
export type { LspTextEdit } from './lsp/lspTextEdit.ts';
export type { LspCodeAction } from './lsp/lspCodeAction.ts';
export type { LspPort } from './lsp/lspPort.ts';
