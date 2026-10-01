import type { SsrfPolicy } from '../../security/ssrfPolicy.js';

/** SSRF 校验选项。 */
export interface SsrfOptions {
  /** 放行私有网段（仅测试或显式信任的内网部署使用，默认 false）。 */
  readonly allowPrivate?: boolean;
  /** 放行云元数据地址（默认 false，元数据端点几乎永远是攻击目标）。 */
  readonly allowMetadata?: boolean;
  /**
   * 策略表（可配置）：元数据主机 / 内网域名后缀 / IPv4 网段。缺省用内置默认档
   * DEFAULT_SSRF_POLICY（见 security/ssrfPolicy）。
   * 由组合根从配置解析后注入（`resolveSsrfPolicy(config.ssrfPolicy)`）。
   */
  readonly policy?: SsrfPolicy | undefined;
  /** 是否做 DNS 解析后二次判定（默认 false：解析有网络开销且引入 TOCTOU 窗口）。 */
  readonly resolveDns?: boolean;
}
