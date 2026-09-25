/**
 * SSRF / 出站策略表（**可配置**）——把原先硬编码在实现里的三张表移入配置。
 *
 * ## 为什么（用户指令 + 审计）
 *
 * `ssrfGuard` 曾把 `METADATA_HOSTS` / `INTERNAL_SUFFIXES` / `IPV4_BLOCKS` 三张表写死在类里：
 * 想加一个自建元数据端点、或把某个内网域从黑名单里放出来，都必须改代码重新发布；
 * 而这类表**本身就是策略数据**，与企业网络拓扑/云厂商清单强相关，属「随环境变化」的部分。
 * 现下沉为配置字段 `ssrfPolicy`（`omniharness.json` 可写），实现里只保留 **默认档**
 * （缺失字段回落默认，保证零配置开箱即用、行为与历史一致）。
 *
 * 默认档本身也已**移出代码**（用户指令，2026-09-22 第二轮）：三张表改由随包发布的
 * `defaults/ssrf.json` 供给，本模块只负责读取、校验与合并——改一条网段/后缀是改数据，
 * 不再是改实现。数据缺失或字段残缺时**当场抛错**（fail-closed）：若静默退化成空表，
 * 护栏会「看着还在、实际更松」。
 *
 * ## 语义（关键，避免「配了却更危险」）
 *
 * - 字段**缺省** ⇒ 用默认表（与历史行为逐字一致）；
 * - 字段**显式给空数组** ⇒ 该项**清空**（例如 `metadataHosts: []` 表示不再额外拦元数据主机名——
 *   这是显式且危险的，故校验层允许但会在文档中标注；未显式给出时绝不静默清空）；
 * - 非法条目（坏 CIDR、空字符串、含空白的域名）⇒ **抛错**（fail-closed），不静默丢弃——
 *   静默丢弃会让人以为「配上了」，实际护栏比预期更松。
 */
import { builtinDefaults } from '../util/builtinDefaults.js';
import { IpAddress } from '../util/ipAddress.js';

/**
 * SsrfPolicy —— 由本文件原顶层函数归并而来（每个方法对应一个原函数，语义与签名逐字保留）。
 */
export class SsrfPolicy {
  /**
   * 校验并解析策略配置（缺省回落默认档）。
   * @param config 配置文件中的 `ssrfPolicy` 段（可为 undefined）
   * @returns 已解析的策略表（可直接喂给 SsrfGuard / NetworkEgressGuard）
   * @throws Error 条目非法时抛出（fail-closed，绝不静默丢弃）
   */
  public static resolveSsrfPolicy(config?: SsrfPolicyConfig): SsrfPolicy {
    if (config === undefined) {
      return DEFAULT_SSRF_POLICY;
    }
    return {
      metadataHosts: SsrfPolicy.resolveMetadataHosts(config.metadataHosts),
      internalSuffixes: SsrfPolicy.resolveInternalSuffixes(config.internalSuffixes),
      ipv4Blocks: SsrfPolicy.resolveIpv4Blocks(config.ipv4Blocks),
    };
  }

  /**
   * 主机清单校验：非空、无空白、小写归一。
   * @param hosts 原始清单（undefined ⇒ 默认表）
   * @returns 归一化后的清单
   * @throws Error 存在空串或含空白的条目
   */
  public static resolveMetadataHosts(hosts?: readonly string[]): readonly string[] {
    if (hosts === undefined) {
      return DEFAULT_SSRF_POLICY.metadataHosts;
    }
    return hosts.map((host) => {
      if (typeof host !== 'string' || host.trim() === '' || /\s/.test(host)) {
        throw new Error(`ssrfPolicy.metadataHosts 含非法主机：${JSON.stringify(host)}`);
      }
      return host.toLowerCase();
    });
  }

  /**
   * 域名后缀校验：必须以 `.` 开头（否则「后缀」会退化成任意包含匹配）。
   * @param suffixes 原始后缀清单（undefined ⇒ 默认表）
   * @returns 归一化后的后缀清单
   * @throws Error 存在不以点开头 / 空 / 含空白的条目
   */
  public static resolveInternalSuffixes(suffixes?: readonly string[]): readonly string[] {
    if (suffixes === undefined) {
      return DEFAULT_SSRF_POLICY.internalSuffixes;
    }
    return suffixes.map((suffix) => {
      if (typeof suffix !== 'string' || suffix.trim() === '' || /\s/.test(suffix)) {
        throw new Error(`ssrfPolicy.internalSuffixes 含非法后缀：${JSON.stringify(suffix)}`);
      }
      const lowered = suffix.toLowerCase();
      if (!lowered.startsWith('.')) {
        throw new Error(`ssrfPolicy.internalSuffixes 必须以 "." 开头：${suffix}`);
      }
      return lowered;
    });
  }

  /**
   * CIDR 清单校验：base 必须是合法 IPv4、bits 必须是 0–32 的整数。
   * @param blocks 原始 CIDR 清单（undefined ⇒ 默认表）
   * @returns 已校验的 CIDR 清单
   * @throws Error 存在非法网段（坏 IP 或越界前缀长度）
   */
  public static resolveIpv4Blocks(
    blocks?: readonly (readonly [string, number])[],
  ): readonly (readonly [string, number])[] {
    if (blocks === undefined) {
      return DEFAULT_SSRF_POLICY.ipv4Blocks;
    }
    return blocks.map((entry) => {
      const base = Array.isArray(entry) ? entry[0] : undefined;
      const bits = Array.isArray(entry) ? entry[1] : undefined;
      if (typeof base !== 'string' || IpAddress.ipv4ToInt(base) === null) {
        throw new Error(`ssrfPolicy.ipv4Blocks 含非法网段地址：${JSON.stringify(entry)}`);
      }
      if (typeof bits !== 'number' || !Number.isInteger(bits) || bits < 0 || bits > 32) {
        throw new Error(
          `ssrfPolicy.ipv4Blocks 的前缀长度须为 0–32 的整数：${JSON.stringify(entry)}`,
        );
      }
      return [base, bits] as const;
    });
  }
}

/** SSRF 策略表（已解析、已校验，供实现直接消费）。 */
export interface SsrfPolicy {
  /** 云元数据主机（恒拦截，白名单不可覆盖）。 */
  readonly metadataHosts: readonly string[];
  /** 内网/本机域名后缀（如前缀任意位置命中即拦）。 */
  readonly internalSuffixes: readonly string[];
  /** IPv4 私有/保留网段（CIDR 列表）。 */
  readonly ipv4Blocks: readonly (readonly [string, number])[];
}

/**
 * 配置文件中 `ssrfPolicy` 段的形状（原始 JSON 值，未校验）。
 * 三个字段均可缺省（缺省即回落默认表）。
 */
export interface SsrfPolicyConfig {
  /** 云元数据主机清单（覆盖默认表）。 */
  readonly metadataHosts?: readonly string[];
  /** 内网/本机域名后缀清单（覆盖默认表）。 */
  readonly internalSuffixes?: readonly string[];
  /** IPv4 私有/保留网段（形如 `[["10.0.0.0", 8], ...]`，覆盖默认表）。 */
  readonly ipv4Blocks?: readonly (readonly [string, number])[];
}

/**
 * `defaults/ssrf.json` 的原始内容（模块加载期读出，缺失/残缺即抛错）。
 * 三张表都是**安全默认档**，故不允许任一段缺省——缺了就直接拒绝启动，而不是退化成空表。
 */
const RAW_SSRF_DEFAULTS: unknown = builtinDefaults.json('ssrf');
if (
  typeof RAW_SSRF_DEFAULTS !== 'object' ||
  RAW_SSRF_DEFAULTS === null ||
  Array.isArray(RAW_SSRF_DEFAULTS)
) {
  throw new Error(
    'defaults/ssrf.json 顶层应为对象：{ metadataHosts, internalSuffixes, ipv4Blocks }',
  );
}
const BUILTIN_SSRF_DEFAULTS = RAW_SSRF_DEFAULTS as SsrfPolicyConfig;
for (const field of ['metadataHosts', 'internalSuffixes', 'ipv4Blocks'] as const) {
  if (!Array.isArray(BUILTIN_SSRF_DEFAULTS[field])) {
    throw new Error(
      `defaults/ssrf.json 必须同时给出 metadataHosts / internalSuffixes / ipv4Blocks 三个数组，` +
        `当前 ${field} 缺失或不是数组 —— 任一段残缺都会让 SSRF 护栏静默变松，故按 fail-closed 当场拒绝。`,
    );
  }
}

/**
 * **默认策略表**：值全部来自 `defaults/ssrf.json`（历史硬编码值已逐字迁入数据文件）。
 *
 * 与用户配置走**同一套解析器**（`resolveSsrfPolicy` 的逐条校验），不存在「默认档不校验」的旁路。
 *
 * 变更纪律：这里的任何改动都会改变所有未配置用户的拦截面 ⇒ 需在看板登记并附理由；
 * 想「只对自己环境生效」请写配置文件，而不是改数据文件。
 */
export const DEFAULT_SSRF_POLICY: SsrfPolicy = {
  metadataHosts: SsrfPolicy.resolveMetadataHosts(BUILTIN_SSRF_DEFAULTS.metadataHosts),
  // 注意 `.corp`：它原先**只**存在于出站守卫（NetworkEgressGuard）的私有主机正则里，
  // 而 SSRF 护栏的默认后缀表没有它 ⇒ 两个守卫对「企业内网域名」的判定不一致。
  // 配置化时把两处合一，`.corp` 并入默认后缀表（属**收紧**：SSRF 护栏现在也拦 `.corp`）。
  internalSuffixes: SsrfPolicy.resolveInternalSuffixes(BUILTIN_SSRF_DEFAULTS.internalSuffixes),
  ipv4Blocks: SsrfPolicy.resolveIpv4Blocks(BUILTIN_SSRF_DEFAULTS.ipv4Blocks),
};
