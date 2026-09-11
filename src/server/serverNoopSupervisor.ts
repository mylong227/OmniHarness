import type { HealthSnapshot, SafeMode, SupervisorPort } from '../ports/supervisor.js';

/**
 * 服务端 no-op 监督内核：仅当启动时 `--auto-approve` 或 UI 审批档位为 auto
 * （用户显式选「完全访问 + 工具全部自动放行」）时挂上——SupervisorKernel 的
 * fail-closed 降级会永久拦截 write_file/shell/apply_patch，与用户终局授权冲突。
 *
 * 其余配置保持原 SupervisorKernel 不动——本类只放行、模式恒 nominal，不修改生产级安全
 * 策略面。eval 端的 NoopSupervisor 在 `src/eval/evalHarness.ts`，不复用避免拉耦。
 */
export class ServerNoopSupervisor implements SupervisorPort {
  /** 无操作：no-op 内核不采集任何健康条目。 */
  public report(): void {}

  /** 恒定 nominal 模式。 */
  public mode(): SafeMode {
    return 'nominal';
  }

  /** 空健康快照。 */
  public snapshot(): HealthSnapshot {
    return { mode: 'nominal', entries: [], generatedAt: new Date().toISOString() };
  }

  /** 不拦截任何工具（返回 undefined = 放行）。 */
  public intercept(): string | undefined {
    return undefined;
  }

  /** 无模式迁移事件。 */
  public onTransition(): void {}

  /** 无恢复流程，恒 nominal。 */
  public attemptRecovery(): SafeMode {
    return 'nominal';
  }
}
