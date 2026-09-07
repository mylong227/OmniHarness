/**
 * 航天级监督内核端口（I-P0-3 / FDIR）。
 *
 * 把 NASA 风格的 Fault Detection, Isolation, Recovery 收敛为一个确定性状态机：
 * 监控工具执行健康度 → 失败率超阈分级降级 → 危险动作零越权 → 优雅恢复。
 * 本端口是「ML 层之上的确定性否决」，优先级高于 Approval/Sandbox——任何它判为
 * 危险的动作在 ToolGate 最前被拦下，审批/沙箱放行也无效。
 *
 * @beta 属 P0 内核升级子系统，接口仍可能微调。
 */
import type { AuditEvent } from '../server/audit.js';

/** 监督模式（FDIR 分级状态机）。 */
export type SafeMode =
  | 'nominal' // 正常：全部工具健康，无干预
  | 'degraded' // 降级：部分工具失败率超阈，进入更严审批/沙箱（仍放行非危险动作）
  | 'safe' // 安全模式：连续/高失败或危险工具触雷，危险动作一律拒（仅非危险动作放行，且强制收紧）
  | 'locked'; // 锁定：严重连续故障，仅非危险动作放行，危险动作零越权（fail-closed）

/** 单工具健康条目（健康向量的一项）。 */
export interface HealthEntry {
  /** 工具名。 */
  readonly tool: string;
  /** 健康分 0..1，1=完全健康（成功数 / 总数）。 */
  readonly health: number;
  /** 滑动窗口内失败次数。 */
  readonly failures: number;
  /** 滑动窗口内成功次数。 */
  readonly successes: number;
  /** 最近一次错误（若有）。 */
  readonly lastError?: string;
}

/** 健康快照：当前模式 + 全部工具健康向量。 */
export interface HealthSnapshot {
  readonly mode: SafeMode;
  readonly entries: ReadonlyArray<HealthEntry>;
  /** ISO 时间戳。 */
  readonly generatedAt: string;
}

/** 审计 sink 结构类型（与 `AuditSink` 兼容，零耦合、零运行时依赖）。 */
export interface AuditSinkLike {
  record(entry: AuditEvent): number | undefined;
}

/** 监督内核选项（全部带默认值，零配置可用）。 */
export interface SupervisorOptions {
  /** 滑动窗口大小（默认 32）：仅最近 N 次执行计入健康分。 */
  readonly windowSize?: number;
  /** 失败率阈值，超过即 degraded（默认 0.25）。 */
  readonly degradeThreshold?: number;
  /** 失败率阈值，超过即 safe（默认 0.5）。 */
  readonly safeThreshold?: number;
  /** 连续失败累计达此值即 locked（默认 5）。 */
  readonly lockAfterConsecutiveFailures?: number;
  /** 危险工具名（进入 safe/locked 后一律拒绝）。可传数组或集合。 */
  readonly hazardousTools?: ReadonlySet<string> | ReadonlyArray<string>;
  /** 审计 sink（可选）：模式切换时把健康快照写入哈希链。 */
  readonly audit?: AuditSinkLike;
  /** 会话标识（写入审计 detail 用）。 */
  readonly sessionId?: string;
}

/** 监督内核端口。 */
export interface SupervisorPort {
  /** 上报一次工具执行结果，驱动健康向量与状态机转移。 */
  report(tool: string, outcome: 'success' | 'failure', error?: string): void;
  /** 当前监督模式。 */
  mode(): SafeMode;
  /** 当前健康快照（含全部工具健康向量）。 */
  snapshot(): HealthSnapshot;
  /**
   * 门禁前向拦截（fail-closed）：返回拒绝理由即否决该工具调用，
   * 优先级高于 Approval/Sandbox。返回 undefined 表示放行（交回门禁裁决）。
   */
  intercept(tool: string): string | undefined;
  /** 订阅模式变更（每次转移触发一次，含新快照）。 */
  onTransition(cb: (from: SafeMode, to: SafeMode, snapshot: HealthSnapshot) => void): void;
  /** 主动恢复尝试：按健康恢复情况逐级回升（locked→safe→degraded→nominal）。 */
  attemptRecovery(): SafeMode;
}
