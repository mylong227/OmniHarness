/**
 * @beta
 * LSP 代码导航工具名（模型面，供 agent 在会话内跳转/查引用/看文档）。
 */
export const LSP_GO_TO_DEFINITION_TOOL_NAME = 'lsp_go_to_definition';
/**
 * @beta
 */
export const LSP_FIND_REFERENCES_TOOL_NAME = 'lsp_find_references';
/**
 * @beta
 */
export const LSP_HOVER_TOOL_NAME = 'lsp_hover';
/**
 * @beta
 */
export const LSP_STATUS_TOOL_NAME = 'lsp_status';
/**
 * @beta
 * 文档诊断（编译/类型错误）工具名：改完代码立即拿回错误列表，无需先跑一次构建。
 */
export const LSP_DIAGNOSTICS_TOOL_NAME = 'lsp_diagnostics';
/**
 * @beta
 * 文档符号目录工具名：通读大文件前先摸清结构，避免为「某符号在第几行」整读文件。
 */
export const LSP_DOCUMENT_SYMBOLS_TOOL_NAME = 'lsp_document_symbols';
/**
 * @beta
 * 代码操作（快速修复/重构建议）工具名：只读查询，落盘仍须经 edit/apply_patch。
 */
export const LSP_CODE_ACTION_TOOL_NAME = 'lsp_code_action';
/**
 * @beta
 * 全局符号搜索工具名：只知道符号名、不知道文件时，用服务器索引一次定位。
 */
export const LSP_WORKSPACE_SYMBOLS_TOOL_NAME = 'lsp_workspace_symbols';
