/**
 * AppServer 的「进化治理台」处理器（**F2**）：把晋升台账的数据面暴露给工作台 UI。
 *
 * ## 为什么单独成层
 *
 * 沿 `AppServerBase → AppServerHandlers → AppServerSurfaceHandlers → **本层** → AppServer` 的分层约定：
 * 本层职责是「治理台账的只读视图 + 回滚入口」，与 SurfaceHandlers 的「会话容量 / 配额 / 检索」无重合。
 * 塞进上游会让"一个类一个功能点"失守，也让 UI 能力的协作者装配无处安放。
 *
 * ## 与 F2 判据的关系（数据与证据同源）
 *
 * `governance.history` 直接返回 {@link PromotionHistoryService.view()} 的结果——UI 上**每一行**
 * 都带着该行**自己**的独立复核结论（自算哈希 + 链式连接），而不是把台账整链结论抄一遍。
 * UI 只是把它渲染出来；判据在数据面（`promotionHistoryService.test.ts`）已经钉死。
 *
 * ## 只读边界
 *
 * 本层**不**提供"直接改台账"的方法：回滚入口 `governance.rollbackTargets` 只给**候选锚点**，
 * 真正回滚仍走 `evolution rollback --yes`（治理动作必须显式确认，不能在 UI 上一点就改历史）。
 *
 * @maturity L1 — history 转发只读视图 / 坏台账仍可用且逐行标红 / 回滚入口只给锚点不执行 判据钉死
 * @maturityEvidence tests/unit/appServerGovernance.test.ts
 */
import { join } from 'node:path';
import { HashChainPromotionLedger } from '../../evolution/hashChainPromotionLedger.js';
import { FeatureEntitlements } from '../../license/featureEntitlements.js';
import { PromotionHistoryService } from '../../governance/promotionHistoryService.js';
import type { PromotionHistoryView } from '../../governance/promotionHistoryService.js';
import { AppServerSurfaceHandlers } from './appServerSurfaceHandlers.js';

/** 默认台账目录（与 CLI / 组合根同一口径：`<workspace>/.omniharness/evolution`）。 */
const LEDGER_DIR = join('.omniharness', 'evolution');

/** 治理台处理器层。 */
export class AppServerGovernanceHandlers extends AppServerSurfaceHandlers {
  /**
   * @param options 服务端选项（与基座同一份，装配期只读使用）
   */
  public constructor(options: import('./appServerState.js').AppServerOptions) {
    super(options);
  }

  /**
   * 注册治理台 RPC（`governance.history` / `governance.rollbackTargets`）。
   * @returns 无返回值
   */
  protected registerGovernanceHandlers(): void {
    this.handlers.set('governance.history', async () => this.governanceView());
    this.handlers.set('governance.rollbackTargets', async () => {
      const result = this.governanceView();
      // 不可用时同样返回 `available:false`：UI 据此显示"台账读不出来"，
      // 而不是收到一个空列表（空列表会被误读成"没有可回滚的快照"）。
      if (!result.available) return result;
      return { available: true, targets: result.view.rollbackTargets };
    });
  }

  /**
   * 读当前工作区的晋升台账并组装治理台视图。
   *
   * **坏台账也要能看**：台账构造失败（目录不可写 / 文件损坏）不抛给 UI——返回 `available:false`
   * 与可读原因。治理台的用途之一就是"看出问题"，让它自己先崩掉是最差的选择。
   * @returns 视图 + 可用性（`available:false` 时 `reason` 必填）
   */
  private governanceView():
    | { readonly available: true; readonly view: PromotionHistoryView }
    | {
        readonly available: false;
        readonly reason: string;
        readonly code?: string | undefined;
      } {
    // **F4 闸门（Pro）**：治理台是商业档能力（§6.1），无授权即不可用——但**拒因必须可读且可机读**，
    // 且**绝不**影响核心功能（台账本身照常写入；`audit verify` 等完整性工具永不上闸）。
    const entitlement = (this.options.entitlements ?? FeatureEntitlements.core()).demand(
      'governance-console',
    );
    if (!entitlement.allowed) {
      return { available: false, reason: entitlement.reason, code: entitlement.code };
    }
    const dir = join(this.configStore.workspace(), LEDGER_DIR);
    try {
      const ledger = new HashChainPromotionLedger({ dir });
      const view = new PromotionHistoryService(ledger, (entry) =>
        HashChainPromotionLedger.hashOf(entry),
      ).view();
      return { available: true, view };
    } catch (err) {
      return {
        available: false,
        reason: `晋升台账不可用（${dir}）：${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
}
