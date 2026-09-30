import type { LspRange } from './lspRange.js';
import type { LspDiagnosticSeverity } from './lspDiagnosticSeverity.js';

/**
 * @beta
 * 单条诊断（坐标已转回 1-based 编辑器约定）。
 */
export interface LspDiagnostic {
  /** 所属文件系统绝对路径（适配器已把 file:// URI 转回）。 */
  readonly file: string;
  /** 1-based 区间。 */
  readonly range: LspRange;
  /** 严重度。 */
  readonly severity: LspDiagnosticSeverity;
  /** 诊断消息（服务器原文，未做本地化）。 */
  readonly message: string;
  /** 产生该诊断的源（如 `typescript`）。 */
  readonly source?: string | undefined;
  /** 服务器给出的诊断码（如 `TS2304`）。 */
  readonly code?: string | undefined;
}
