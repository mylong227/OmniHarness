import type { SafeMode } from './safeMode.js';
import type { HealthSnapshot } from './healthSnapshot.js';

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
