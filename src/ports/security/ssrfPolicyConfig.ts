/**
 * 配置文件中 `ssrfPolicy` 段的形状（原始 JSON 值，未校验）。
 *
 * 三个字段均可缺省（缺省即回落默认档，见 `security/ssrfPolicy` 的 `resolveSsrfPolicy`）。
 * 已从 `security/ssrfPolicy.ts` 外迁到 ports 域：原文件退化为纯再导出桶，调用点零改动。
 */
export interface SsrfPolicyConfig {
  /** 云元数据主机清单（覆盖默认表）。 */
  readonly metadataHosts?: readonly string[];
  /** 内网/本机域名后缀清单（覆盖默认表）。 */
  readonly internalSuffixes?: readonly string[];
  /** IPv4 私有/保留网段（形如 `[["10.0.0.0", 8], ...]`，覆盖默认表）。 */
  readonly ipv4Blocks?: readonly (readonly [string, number])[];
}
