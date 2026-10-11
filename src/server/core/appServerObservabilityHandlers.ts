/**
 * AppServer 的「只读可观测」处理器（Web 交付项，2026-10-11）：`daemon.status` 与 `doctor.report`。
 *
 * ## 为什么单独成层
 *
 * 沿 `AppServerBase → AppServerHandlers → AppServerSurfaceHandlers → AppServerGovernanceHandlers →
 * **本层** → AppServer` 的分层约定：本层职责是「把本机运行态**如实**告诉面板」，与治理台账、
 * 会话容量都无重合。塞进 `AppServer` 会让那个类越过上帝类阈值（增量门禁 2026-10-11 当场抓到：
 * 733 行 / 25 方法）——分层不是为了好看，是为了不被门禁逼着放宽口径。
 *
 * ## 两条纪律（都在钉"没有就是没有"）
 *
 * 1. `daemon.status` 与 `omniharness daemon status` **同一事实源**：同一个 `DaemonController`、
 *    同一默认 pid 文件（`~/.omniharness/daemon.pid`）⇒ 面板与命令行不会互相打脸；
 * 2. `doctor.report` 未注入实现时**显式报错**（`ok:false` + 原因），绝不返回空报告冒充"体检通过"。
 *
 * @maturity L1 — 两条只读 RPC 与 CLI 同源 / 未接线如实报错 / workspaceRoot 透传 判据钉死
 * @maturityEvidence tests/unit/observabilityRpc.test.ts
 */
import { DaemonController } from '../../daemon/daemonController.js';
import { AppServerGovernanceHandlers } from './appServerGovernanceHandlers.js';

/** 只读可观测处理器层。 */
export class AppServerObservabilityHandlers extends AppServerGovernanceHandlers {
  /**
   * 注册 `daemon.status` 与 `doctor.report`。
   *
   * @returns 无返回值。
   */
  protected registerObservabilityHandlers(): void {
    this.handlers.set('daemon.status', () => Promise.resolve(new DaemonController().status()));
    this.handlers.set('doctor.report', async (params) => {
      const provided = this.options.doctorReport;
      if (provided === undefined) {
        return { ok: false, reason: 'doctor 未接线（serve 组合根未注入 doctorReport）' };
      }
      const workspaceRoot =
        typeof params['workspaceRoot'] === 'string' ? params['workspaceRoot'] : undefined;
      const report = await provided(workspaceRoot === undefined ? undefined : { workspaceRoot });
      return { ok: true, report };
    });
  }
}
