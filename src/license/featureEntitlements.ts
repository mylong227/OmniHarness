/**
 * 功能权益解析器（**F4 落地**：把 `LicenseEngine.FEATURE_TIERS` 从"展示表"变成"产品闸门"）。
 *
 * ## 它做什么
 *
 * 输入一份授权裁决（`LicenseVerdict`），输出一个 {@link EntitlementPort}：
 * - `allowed(feature)`：纯查询，用于分支；
 * - `require(feature)`：带**可机读 code** 的裁决，用于入口点落闸。
 *
 * ## 三条设计口径（都有判据）
 *
 * 1. **档位表只有一个出处**：判定一律走 `LicenseEngine.featureAllowed`，本类不复制一张表。
 *    复制表的代价是"两处不同步"，而权益不同步的形态是"以为锁了其实没锁"。
 * 2. **过期降级而非停摆**：`verdict.tier` 在过期时已是 `core`（F1 的诚实降级档），
 *    故过期用户失去的是 Pro/Team/Enterprise 功能，**core 功能照常**——本类不额外加码。
 * 3. **拒绝即留痕**：每次 `demand` 被拒都发一条结构化事件（§12.1-4），
 *    因为"用户以为买了却用不了"这类问题只能靠日志定位。
 *
 * @maturity L1 — 无授权拒 / 档位不足拒 / 过期降级 / 未知功能拒 / 事件口径 判据钉死
 * @maturityEvidence tests/unit/featureEntitlements.test.ts
 */
import { LicenseEngine } from './licenseEngine.js';
import { log } from '../util/logger.js';
import type { LicenseVerdict } from './licenseEngine.js';
import type {
  EntitlementDecision,
  EntitlementDenialCode,
  EntitlementPort,
} from '../ports/license/entitlement.js';
import type { LicenseTier } from '../ports/license/licenseTier.js';

/** 观测回调（缺省写共享 logger；判据注入采集器以钉死事件口径）。 */
export type EntitlementObserver = (event: string, fields: Record<string, unknown>) => void;

/** 构造入参。 */
export interface FeatureEntitlementsOptions {
  /** 授权裁决（未持授权时用 {@link FeatureEntitlements.core}）。 */
  readonly verdict: LicenseVerdict;
  /** 观测回调（缺省写共享 logger）。 */
  readonly observer?: EntitlementObserver | undefined;
}

/** 功能权益解析器。 */
export class FeatureEntitlements implements EntitlementPort {
  /** 当前生效档位（过期用户由 `verdict` 决定，此处不做二次判断）。 */
  public readonly tier: LicenseTier;
  /** 授权是否有效（`false` = 未持授权或不可采信）。 */
  private readonly licensed: boolean;
  /** 观测回调。 */
  private readonly observe: EntitlementObserver;

  /**
   * 未持授权时的**唯一构造入口**（档位 `core`）。
   *
   * 为什么给静态入口而不是"允许裸造一个 core 裁决"：`core` 是**明确状态**（没买），
   * 不是"未知"；让调用方手搓裁决对象，迟早会有人搓出 `tier:'pro'` 却 `ok:false` 的矛盾体。
   * @param observer 观测回调（可选）
   * @returns core 档权益
   */
  public static core(observer?: EntitlementObserver | undefined): FeatureEntitlements {
    return new FeatureEntitlements({
      verdict: { ok: false, tier: 'core', reason: '未持授权（core 档）', expired: false },
      ...(observer !== undefined ? { observer } : {}),
    });
  }

  /**
   * @param opts 授权裁决与观测回调
   */
  public constructor(opts: FeatureEntitlementsOptions) {
    this.tier = opts.verdict.tier;
    this.licensed = opts.verdict.ok;
    this.observe = opts.observer ?? ((event, fields) => log.warn(event, fields));
  }

  /**
   * 是否允许该功能。
   * @param feature 功能名
   * @returns 允许返回 true；未知功能一律 false（fail-closed）
   */
  public allowed(feature: string): boolean {
    return this.demand(feature).allowed;
  }

  /**
   * 对该功能提出要求（入口点落闸用）。
   * @param feature 功能名（须在 `LicenseEngine.FEATURE_TIERS` 内）
   * @returns 裁决；拒绝时带可机读 code、可读原因与所需档位
   */
  public demand(feature: string): EntitlementDecision {
    const requiredTier = LicenseEngine.FEATURE_TIERS[feature];
    if (requiredTier === undefined) {
      // **未知功能默认拒**：允许"没登记的功能"通过等于给未来留一个静默后门。
      return this.refuse(
        'feature-unknown',
        feature,
        undefined,
        `未知功能 "${feature}"（未在档位表中登记）`,
      );
    }
    if (LicenseEngine.featureAllowed(this.tier, feature)) {
      return { allowed: true, tier: this.tier };
    }
    const code = this.licensed ? 'tier-too-low' : 'no-license';
    return this.refuse(
      code,
      feature,
      requiredTier,
      `功能 "${feature}" 需要 ${requiredTier} 档（当前 ${this.tier}）` +
        (this.licensed ? '' : '；当前未持有效授权'),
    );
  }

  /**
   * 造一条拒绝裁决并留痕。
   * @param code 可机读拒因码
   * @param feature 功能名
   * @param requiredTier 所需档位（未登记功能为 undefined）
   * @param reason 可读原因
   * @returns 拒绝裁决
   */
  private refuse(
    code: EntitlementDenialCode,
    feature: string,
    requiredTier: LicenseTier | undefined,
    reason: string,
  ): EntitlementDecision {
    this.observe('license.entitlement.denied', {
      code,
      feature,
      tier: this.tier,
      ...(requiredTier !== undefined ? { requiredTier } : {}),
    });
    return {
      allowed: false,
      code,
      reason,
      ...(requiredTier !== undefined ? { requiredTier } : {}),
    };
  }
}
