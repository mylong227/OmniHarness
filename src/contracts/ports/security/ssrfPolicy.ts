/**
 * SSRF 策略表（已解析、已校验，供实现直接消费）。
 *
 * 原始 `interface SsrfPolicy` 与 `security/ssrfPolicy.ts` 的 `class SsrfPolicy` 同名合并（既作解析器值、
 * 又作数据形状类型）。此处把**纯数据形状**上提到 ports（[3.5] 端口只依赖契约），原文件保留
 * `interface SsrfPolicy extends ResolvedSsrfPolicy {}` 以维持既有「值（解析器）+ 数据形状」双语义，调用点零改动。
 */
export interface ResolvedSsrfPolicy {
  /** 云元数据主机（恒拦截，白名单不可覆盖）。 */
  readonly metadataHosts: readonly string[];
  /** 内网/本机域名后缀（如前缀任意位置命中即拦）。 */
  readonly internalSuffixes: readonly string[];
  /** IPv4 私有/保留网段（CIDR 列表）。 */
  readonly ipv4Blocks: readonly (readonly [string, number])[];
}
