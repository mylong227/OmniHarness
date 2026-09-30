import type { LspLocation } from './lspLocation.js';
import type { LspDiagnosticReport } from './lspDiagnosticReport.js';
import type { LspSymbol } from './lspSymbol.js';
import type { LspRange } from './lspRange.js';
import type { LspCodeAction } from './lspCodeAction.js';
import type { LspWorkspaceSymbol } from './lspWorkspaceSymbol.js';

/**
 * @beta
 * LSP 代码导航端口：definition / references / hover / diagnostics / symbols / codeActions /
 * workspaceSymbols（工作区级符号搜索）。
 *
 * 实现负责 LSP 握手（initialize → initialized）、文档同步（didOpen / didChange）、生命周期（shutdown → exit），
 * 对上层完全透明——工具/CLI 只调语义方法。坐标统一 **1-based 编辑器约定**，0-based 的 LSP 细节由适配器内部转换。
 *
 * fail-closed：服务器不可用 / 请求超时 / 协议错误时，方法应抛出（由工具层转成可读错误文本），绝不静默返回错误结果。
 */
export interface LspPort {
  /** 端口名（便于调试/状态展示）。 */
  readonly name: string;
  /** 跳转到定义：返回 0..n 个位置（部分语言/符号可能返回多个）。 */
  definition(file: string, line: number, character: number): Promise<readonly LspLocation[]>;
  /** 查找引用：返回所有引用位置（含声明处，若服务器支持）。 */
  references(file: string, line: number, character: number): Promise<readonly LspLocation[]>;
  /** 悬停文档：返回 Markdown/纯文本文档串，无则 undefined。 */
  hover(file: string, line: number, character: number): Promise<string | undefined>;
  /**
   * 取文档诊断（编译/类型错误）：强制触发一次文档重新分析并等待推送，返回带新鲜度的报告。
   * 可选——不支持诊断的适配器可省略（缺失时 `lsp_diagnostics` 工具不注册）。
   */
  diagnostics?(file: string): Promise<LspDiagnosticReport>;
  /**
   * 列出文档符号（函数/类/方法/变量的层级清单）。
   *
   * 可选——不支持符号查询的适配器可省略（缺失时 `lsp_document_symbols` 工具不注册）。
   * 之所以对「不支持」留出可选位：注册一个必然失败的工具比不注册更糟，
   * 它会把上下文浪费在一次注定报错的往返上，还给模型一个假信号。
   */
  symbols?(file: string): Promise<readonly LspSymbol[]>;
  /**
   * 取指定区间的代码操作（快速修复/重构）。
   *
   * 可选，理由同 {@link LspPort.symbols}。
   */
  codeActions?(file: string, range: LspRange): Promise<readonly LspCodeAction[]>;
  /**
   * 在工作区范围内按名字模糊查询符号（`workspace/symbol`）。
   *
   * 与 {@link LspPort.symbols} 互补，而不是重复：文档符号要求**先知道文件**，
   * 而模型最常见的起点恰是「只知道一个名字」——它想按名字找定义在哪。
   * 旧做法只能把整个仓库 grep 一遍再逐个打开候选文件，既吃上下文又漏掉
   * 「名字对不上但语义相同」的符号；`workspace/symbol` 直接给出服务器索引里的权威清单。
   *
   * 兼容性：部分服务器返回 `SymbolInformation[]`（扁平、位置在 `location`、可能带 `containerName`），
   * 另一部分返回 `WorkspaceSymbol[]`（位置可能是 `location`，也可能是 LSP 3.17 的 `Location | { uri }`
   * 二选一形态）；实现必须把两种形状**归一**为 {@link LspWorkspaceSymbol}。
   *
   * 可选——不支持全局符号查询的适配器可省略（缺失时 `lsp_workspace_symbols` 工具不注册）。
   * 理由同 {@link LspPort.symbols}：注册一个注定失败的工具比不注册更糟。
   *
   * @param query 符号名查询串（服务器侧通常按子串/模糊匹配；空串在多数服务器上等价于「全部」，
   *   但调用方应自行决定是否允许空查询——本层不做限制，只如实下发）。
   * @returns 工作区符号清单；服务器无可匹配结果或返回非法形状时为空数组。
   */
  workspaceSymbols?(query: string): Promise<readonly LspWorkspaceSymbol[]>;
  /** 关闭会话：发 shutdown → exit 并终止子进程。 */
  shutdown(): Promise<void>;
}
