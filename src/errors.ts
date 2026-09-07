/**
 * 集中错误码目录（#P2，对标成熟 harness 的 error catalog）。
 *
 * 成熟 harness（Codex CLI / Claude Code）对所有可观测、可分类的错误都带**稳定错误码**，
 * 便于日志关联、上层重试判定与跨组件对齐。此前项目错误类零散、无统一 code，
 * 本文件把错误码收敛为单一真相源，并提供 `OmniError` 基类。
 *
 * 约定：新增错误码请**追加**到 `ErrorCode`，勿修改既有值（避免破坏上游契约与日志查询）。
 */

/** 稳定错误码（字符串常量）。 */
export const ErrorCode = {
  /** 配置严格校验失败（未知 key / 类型 / 枚举越界）。 */
  CONFIG_ERROR: 'CONFIG_ERROR',
  /** 模型调用失败（HTTP/网络层）。 */
  MODEL_CALL_ERROR: 'MODEL_CALL_ERROR',
  /** 成本硬预算耗尽熔断。 */
  BUDGET_EXCEEDED: 'BUDGET_EXCEEDED',
  /** 插件权限未在白名单内被拒。 */
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  /** 工作流 DAG 存在环。 */
  WORKFLOW_CYCLE: 'WORKFLOW_CYCLE',
  /** 原生内核未加载（.node 未构建或加载失败）。 */
  NATIVE_KERNEL_UNAVAILABLE: 'NATIVE_KERNEL_UNAVAILABLE',
  /** 网络外联被 SSRF / 白名单策略拒绝。 */
  EGRESS_BLOCKED: 'EGRESS_BLOCKED',
  /** 未分类的未知错误。 */
  UNKNOWN: 'UNKNOWN',
} as const;

/** 错误码取值类型。 */
export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

/** 带稳定错误码的基础错误类：所有可分类错误应继承它。 */
export class OmniError extends Error {
  /** 稳定错误码（跨组件可关联、可查询）。 */
  readonly code: ErrorCodeValue;

  constructor(code: ErrorCodeValue, message: string) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
  }
}
