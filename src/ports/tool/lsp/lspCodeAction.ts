import type { LspTextEdit } from './lspTextEdit.js';

/**
 * @beta
 * 一条代码操作（快速修复/重构建议）。
 *
 * `edits` 是**已压平**的文本编辑列表：语言服务器可能用 `changes`（按 URI 分组）
 * 或 `documentChanges`（带版本与文件操作）两种编码，上层不该关心这个区别。
 * 只有 `command`（需服务器侧执行）而无 `edit` 的操作，`edits` 为空数组——
 * 本层**不下写**任何文件，只把「改哪儿、改成什么」如实呈现，由模型/用户决定。
 */
export interface LspCodeAction {
  /** 操作标题（服务器原文）。 */
  readonly title: string;
  /** 操作种类（如 `quickfix`、`refactor.extract`）；服务器未给则 undefined。 */
  readonly kind?: string | undefined;
  /** 服务器是否标为「首选」。 */
  readonly isPreferred: boolean;
  /** 该操作包含的文本编辑（可能为空）。 */
  readonly edits: readonly LspTextEdit[];
}
