import type { LspDiagnostic } from './lspDiagnostic.js';

/**
 * @beta
 * 诊断报告。
 *
 * **`status` 是刻意保留的语义**：语言服务器是异步推送诊断的，等待窗口内没有收到推送
 * **不等于**「没有错误」。因此本报告显式区分：
 * - `fresh`：本次请求期间收到了该文件的 `publishDiagnostics` ⇒ 诊断即当前真值（含「确实为空」）；
 * - `stale`：仅在等待窗口内未收到推送，返回的是缓存（可能为空、也可能过期）⇒ 调用方
 *   必须把这一区别如实告诉模型，**绝不允许把 stale 当成「编译通过」**。
 */
export interface LspDiagnosticReport {
  /** 目标文件系统绝对路径。 */
  readonly file: string;
  /** 诊断列表（fresh 时即当前真值）。 */
  readonly diagnostics: readonly LspDiagnostic[];
  /** 数据新鲜度。 */
  readonly status: 'fresh' | 'stale';
}
