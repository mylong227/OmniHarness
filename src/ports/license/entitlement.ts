/**
 * 功能权益端口（**F4 的落点**：让"档位 → 功能"从展示表变成**产品路径上的闸门**）。
 *
 * ## 为什么需要它（这是本仓真实存在的缺口）
 *
 * `LicenseEngine.FEATURE_TIERS` 早已把"哪些功能要哪一档"写成表，但 2026-10-04 复核发现：
 * `featureAllowed` **只被 license CLI 自己调用**用于打印，`LicenseEngine.verify` 在生产路径上
 * **零调用** ⇒ 买不买 license 对产品行为**毫无影响**（档位表是装饰）。
 * 本端口就是那个缺失的消费面。
 *
 * ## 两条硬口径
 *
 * 1. **fail-closed**：没有 license / 档位不够 / 已过期 ⇒ **拒**，且给可机读 code 与可读原因；
 *    绝不"没 license 就全开"或"过期就静默放行"。
 * 2. **安全与完整性永不上闸**：`audit verify`（哈希链复核）、门禁输出、拒因本身**不属于任何档位**。
 *    把"验证治理链条"做成付费能力，等于把可审计性变成商业模式——本仓明确不这么做（见文档 §6.1 口径）。
 */
import type { LicenseTier } from './licenseTier.js';

/** 权益拒绝的**可机读码**（§12.1-4）。 */
export type EntitlementDenialCode = 'no-license' | 'tier-too-low' | 'expired' | 'feature-unknown';

/** 权益裁决。 */
export type EntitlementDecision =
  | { readonly allowed: true; readonly tier: LicenseTier }
  | {
      readonly allowed: false;
      /** 可机读拒因码。 */
      readonly code: EntitlementDenialCode;
      /** 可读原因（点名功能、当前档位、所需档位）。 */
      readonly reason: string;
      /** 该功能所需的最低档位（`feature-unknown` 时为 undefined）。 */
      readonly requiredTier?: LicenseTier | undefined;
    };

/** 功能权益端口。 */
export interface EntitlementPort {
  /** 当前生效档位。 */
  readonly tier: LicenseTier;
  /**
   * 是否允许该功能（**只回答是/否**，用于分支；需要原因时用 `demand`）。
   * @param feature 功能名（须在 `LicenseEngine.FEATURE_TIERS` 内）
   * @returns 允许返回 true
   */
  allowed(feature: string): boolean;
  /**
   * 对该功能提出要求（**带回绝原因**，用于入口点落闸）。
   * @param feature 功能名
   * @returns 裁决（拒绝时带 code 与原因）
   */
  demand(feature: string): EntitlementDecision;
}
