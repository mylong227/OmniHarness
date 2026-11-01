import type { ResolvedSsrfPolicy } from './ssrfPolicy.ts';

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
  readonly policy?: ResolvedSsrfPolicy | undefined;
  /**
   * 是否做 DNS 解析后二次判定（**默认 true**，2026-11-01 改判）。
   *
   * 原登记的默认关闭理由（解析开销 + TOCTOU）经复核不成立：
   * - 开销＝每次出站校验一次 getaddrinfo（OS 有缓存），相对其后的 HTTP 请求可忽略；
   * - TOCTOU 论证与实现自相矛盾——`assertNotSsrf` 校验后调用方 `fetch(url)` 本来就会再解析，
   *   关闭 DNS 判定并不消除窗口，只是把「域名→内网/云元数据 IP」这整类绕过白白让出去。
   * 改判后的**残余风险（如实登记，未解决）**：校验与真实请求之间的 DNS rebinding 仍可能
   * （需在连接层钉住已校验 IP 才能根治），见 PROJECT_BOARD §203。
   */
  readonly resolveDns?: boolean;
}
