import type { SsrfPolicy } from '../../../security/ssrfPolicy.js';

/** 网络外联守卫配置。 */
export interface NetworkEgressOptions {
  /** 允许的主机后缀列表。 */
  readonly allowedHosts: readonly string[];
  /**
   * 是否拦截私有/链路本地地址（SSRF 防护，默认 true）。
   * 即使主机在白名单内，命中私有网段/云元数据 IP 也一律拒绝——白名单不能覆盖 SSRF。
   * 仅当调用方明确信任本地环路场景时才置 false（如仅允许 localhost 调试）。
   */
  readonly blockPrivateRanges?: boolean;
  /**
   * SSRF 策略表（可配置）：元数据主机 / 内网域名后缀 / IPv4 网段。缺省用默认档。
   * 由组合根从配置解析后注入（resolveSsrfPolicy(config.ssrfPolicy)），与 SsrfGuard 同源。
   */
  readonly policy?: SsrfPolicy | undefined;
}
