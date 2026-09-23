/**
 * @beta
 * LSP 代码导航工具名（模型面，供 agent 在会话内跳转/查引用/看文档）。
 *
 * 值统一来自 `ports/tool/toolNames.ts`（工具名**单一来源**，2026-09-22 第三轮收口）：
 * 本模块保留原有导出名，既有调用点零改动，但工具标识在全仓只声明一次——
 * 此前策略表（如 plan 模式只读白名单）另写一份 `lsp_*` 字面量，漏改即静默误拦。
 */
import { TOOL_NAMES } from '../../ports/tool/toolNames.js';

/**
 * @beta
 */
export const LSP_GO_TO_DEFINITION_TOOL_NAME = TOOL_NAMES.lspGoToDefinition;
/**
 * @beta
 */
export const LSP_FIND_REFERENCES_TOOL_NAME = TOOL_NAMES.lspFindReferences;
/**
 * @beta
 */
export const LSP_HOVER_TOOL_NAME = TOOL_NAMES.lspHover;
/**
 * @beta
 */
export const LSP_STATUS_TOOL_NAME = TOOL_NAMES.lspStatus;
/**
 * @beta
 * 文档诊断（编译/类型错误）工具名：改完代码立即拿回错误列表，无需先跑一次构建。
 */
export const LSP_DIAGNOSTICS_TOOL_NAME = TOOL_NAMES.lspDiagnostics;
/**
 * @beta
 * 文档符号目录工具名：通读大文件前先摸清结构，避免为「某符号在第几行」整读文件。
 */
export const LSP_DOCUMENT_SYMBOLS_TOOL_NAME = TOOL_NAMES.lspDocumentSymbols;
/**
 * @beta
 * 代码操作（快速修复/重构建议）工具名：只读查询，落盘仍须经 edit/apply_patch。
 */
export const LSP_CODE_ACTION_TOOL_NAME = TOOL_NAMES.lspCodeAction;
/**
 * @beta
 * 全局符号搜索工具名：只知道符号名、不知道文件时，用服务器索引一次定位。
 */
export const LSP_WORKSPACE_SYMBOLS_TOOL_NAME = TOOL_NAMES.lspWorkspaceSymbols;
