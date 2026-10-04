import type { IsolationLevel } from '../capability/isolationLevel.js';
import type { TrustTier } from '../capability/trustTier.js';

/**
 * 统一资产协议配置段（Wave B · ADR-0009）。
 *
 * 三个子键各有明确归属，**不留「看起来能用」的模糊键**：
 * - `enabled`：总开关（缺省 false = 零行为变更，沿目标架构 S2「一切新机制默认关」）；
 * - `sources`：资产来源路径（Wave D 的签名资产包目录；本波只做校验与透传，不消费）；
 * - `isolationDefaults`：默认档位的**下限**（装配器据此收紧，只可更严——档位全序见端口）。
 *
 * 与 `FileConfig.capability` 共用同一份结构（`ports/config/fileConfig.ts` 引用本类型）。
 */
export interface CapabilityConfig {
  /** 总开关（缺省 false）。 */
  readonly enabled?: boolean;
  /** 资产来源路径（Wave D 消费；本波只校验与透传）。 */
  readonly sources?: readonly string[];
  /**
   * 默认信任档 / 隔离档（装配时作为**下限**收紧：注册表只会把它应用到新建资产，
   * 已有资产的档位变更仍走 `setGovernance` 的「只收紧」判据）。
   */
  readonly isolationDefaults?: {
    /** 默认信任档（缺省由各类型 schema 决定）。 */
    readonly trustTier?: TrustTier;
    /** 默认隔离档（缺省由各类型 schema 决定）。 */
    readonly isolation?: IsolationLevel;
  };
}
