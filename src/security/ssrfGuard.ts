import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { embeddedIpv4, isPrivateIpv4, isPrivateIpv6 } from '../util/ipAddress.js';
import { DEFAULT_SSRF_POLICY, type SsrfPolicy } from './ssrfPolicy.js';

/**
 * SSRF 防护：拦截私有/保留网段与云元数据端点的访问。
 *
 * 威胁模型：agent 的工具或配置可能携带外部提供的 URL（A2A 端点、provider 探测地址、
 * web 抓取目标）。若无网段屏蔽，攻击者可让 agent 去请求 `169.254.169.254`（云元数据）、
 * `127.0.0.1:8080`（本机管理端口）或内网服务，形成 SSRF。
 *
 * 零依赖实现（依赖准入铁律）：字面量判定用 `node:net.isIP` + 自实现网段比较，
 * DNS 解析用 `node:dns`。未开启 DNS 解析时只做字面判定（同步、零网络开销）。
 *
 * OOP 收口：原模块级常量与纯函数归拢为 `SsrfGuard` 类（常量挂 private static readonly，
 * 判定逻辑为实例方法）；保留 `inspectHost` / `inspectUrl` / `assertNotSsrf` /
 * `defaultSsrfOptions` 同名门面（委托默认实例），既有调用点（a2aTransportHttp.ts、
 * providerProbe.ts、tests/unit/ssrfGuard.test.ts）无需改动。
 */

/** SSRF 校验选项。 */
export interface SsrfOptions {
  /** 放行私有网段（仅测试或显式信任的内网部署使用，默认 false）。 */
  readonly allowPrivate?: boolean;
  /** 放行云元数据地址（默认 false，元数据端点几乎永远是攻击目标）。 */
  readonly allowMetadata?: boolean;
  /**
   * 策略表（可配置）：元数据主机 / 内网域名后缀 / IPv4 网段。缺省用 {`@link DEFAULT_SSRF_POLICY`}。
   * 由组合根从配置解析后注入（`resolveSsrfPolicy(config.ssrfPolicy)`）。
   */
  readonly policy?: SsrfPolicy | undefined;
  /** 是否做 DNS 解析后二次判定（默认 false：解析有网络开销且引入 TOCTOU 窗口）。 */
  readonly resolveDns?: boolean;
}

/** SSRF 拦截原因。 */
export type SsrfVerdict =
  { readonly blocked: false } | { readonly blocked: true; readonly reason: string };

/**
 * SSRF 防护引擎：云元数据/私有网段/非法字面量判定，fail-closed。
 *
 * 三张策略表（元数据主机 / 内网域名后缀 / IPv4 网段）**不再硬编码在本类**：
 * 默认档在 `security/ssrfPolicy.ts`，可由配置 `ssrfPolicy` 覆盖，
 * 调用方把解析后的策略随 {@link SsrfOptions.policy} 传入（组合根负责解析与注入）。
 */
export class SsrfGuard {
  /**
   * 默认 SSRF 策略。
   *
   * 权衡说明（这是产品决策，不是技术默认值）：
   * - 本项目的 A2A 默认对端端点就是 `http://localhost:8790/a2a`，本地 Ollama 等模型服务
   *   同样是核心场景，因此**默认放行私有网段**——否则出厂配置直接不可用，用户会关掉整个防护。
   * - 但**云元数据地址永远拦截**（`allowMetadata` 不受 `allowPrivate` 影响）：
   *   169.254.169.254 这类端点几乎不存在合法用途，是 SSRF 的首要攻击目标。
   * - 设 `OMNI_SSRF_STRICT=1` 可开启严格模式（连私有网段一并拦截），适用于不可信输入场景。
   */
  public defaultOptions(): SsrfOptions {
    const strict = process.env['OMNI_SSRF_STRICT'] === '1';
    return { allowPrivate: !strict, allowMetadata: false };
  }

  /** 纯字面量判定（不发起网络请求）。 */
  public inspectHost(host: string, options: SsrfOptions = {}): SsrfVerdict {
    const lower = host.toLowerCase().replace(/^\[|\]$/g, '');
    if (lower === '') {
      return { blocked: true, reason: '空主机名' };
    }
    // 策略表：调用方未注入时回落默认档（与历史行为逐字一致）。
    const policy = options.policy ?? DEFAULT_SSRF_POLICY;
    const metadataHosts = new Set(policy.metadataHosts);
    // 元数据判定必须同时覆盖「IPv6 内嵌 IPv4」的写法（否则 [::ffff:169.254.169.254] 绕过
    // 「元数据永远拦截」——2026-09-22 实测复现并修复）。
    const embedded = isIP(lower) === 6 ? embeddedIpv4(lower) : null;
    if (
      options.allowMetadata !== true &&
      (metadataHosts.has(lower) || (embedded !== null && metadataHosts.has(embedded)))
    ) {
      return { blocked: true, reason: `云元数据地址被拦截: ${host}` };
    }
    if (lower === 'localhost' || policy.internalSuffixes.some((s) => lower.endsWith(s))) {
      return { blocked: true, reason: `本机/内网域名被拦截: ${host}` };
    }
    const version = isIP(lower);
    if (version === 4) {
      if (options.allowPrivate === true) {
        return { blocked: false };
      }
      return isPrivateIpv4(lower, policy.ipv4Blocks)
        ? { blocked: true, reason: `私有/保留 IPv4 被拦截: ${host}` }
        : { blocked: false };
    }
    if (version === 6) {
      if (options.allowPrivate === true) {
        return { blocked: false };
      }
      return isPrivateIpv6(lower, policy.ipv4Blocks)
        ? { blocked: true, reason: `本机/保留 IPv6 被拦截: ${host}` }
        : { blocked: false };
    }
    // 纯数字点分串（如 "1.2.3"、"999.1.1.1"）：不是合法 IPv4，但极可能是内网主机名的
    // 简写形式，且无法用网段规则判定 → fail-closed 拦截，避免被 DNS 解析进内网。
    if (/^[0-9.]+$/.test(lower)) {
      return { blocked: true, reason: `非法 IPv4 字面量: ${host}` };
    }
    // 域名：字面量无法判定，交给可选 DNS 解析。
    return { blocked: false };
  }

  /**
   * 同步 URL 判定（不发起网络请求、不做 DNS 解析）：适合发送前的快速拦截。
   * URL 非法或协议非 HTTP(S) 一律按拦截处理（fail-closed）。
   */
  public inspectUrl(rawUrl: string, options: SsrfOptions = {}): SsrfVerdict {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return { blocked: true, reason: `非法 URL（${rawUrl}）` };
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return { blocked: true, reason: `非 HTTP(S) 协议（${url.protocol}）` };
    }
    return this.inspectHost(url.hostname, options);
  }

  /**
   * SSRF 校验：命中即抛错（fail-closed）。
   * 解析失败、协议非 http/https、URL 非法一律按拦截处理——宁可拒绝也不放行。
   
 * @returns 无返回值。
*/
  public async assertNotSsrf(rawUrl: string, options: SsrfOptions = {}): Promise<void> {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new Error(`SSRF 拦截: 非法 URL（${rawUrl}）`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(`SSRF 拦截: 非 HTTP(S) 协议（${url.protocol}）`);
    }

    const verdict = this.inspectHost(url.hostname, options);
    if (verdict.blocked) {
      throw new Error(`SSRF 拦截: ${verdict.reason}`);
    }

    if (options.resolveDns === true && isIP(url.hostname) === 0) {
      try {
        const resolved = await lookup(url.hostname, { all: true });
        for (const entry of resolved) {
          const hostVerdict = this.inspectHost(entry.address, options);
          if (hostVerdict.blocked) {
            throw new Error(
              `SSRF 拦截: ${url.hostname} 解析到 ${entry.address}（${hostVerdict.reason}）`,
            );
          }
        }
      } catch (error) {
        // 解析失败按拦截处理（fail-closed）：无法证明安全即拒绝。
        if (error instanceof Error && error.message.startsWith('SSRF 拦截')) {
          throw error;
        }
        throw new Error(`SSRF 拦截: DNS 解析失败（${url.hostname}）`);
      }
    }
  }
}

// ---- 门面兼容：保留原导出名，委托默认实例 ----
const ssrfGuard = new SsrfGuard();

/** 默认 SSRF 策略（见 SsrfGuard.defaultOptions 注释）。 */
export function defaultSsrfOptions(): SsrfOptions {
  return ssrfGuard.defaultOptions();
}

/**
 * 由**策略表**构造 SSRF 选项：默认档（`allowPrivate` 保证本地端点可用、`allowMetadata=false`）
 * ＋调用方注入的策略表。
 *
 * 为什么要有这个统一入口：配置化后每个消费点都要「默认档 + 注入策略」，各写一份
 * `{ ...defaultSsrfOptions(), policy }` 极易漏掉默认档——漏了会把本地端点（A2A 回环、
 * 本地 Ollama）误拦，2026-09-22 的 E2 装配回归正是此形态（只传 `{ policy }` ⇒ 本地端点被拦）。
 * @param policy 已解析的策略表（见 `security/ssrfPolicy.resolveSsrfPolicy`）；缺省用内置默认档
 * @returns SSRF 校验选项（可直接喂给 {@link inspectUrl} / {@link assertNotSsrf}）
 */
export function ssrfOptionsFor(policy?: SsrfPolicy): SsrfOptions {
  return { ...ssrfGuard.defaultOptions(), policy: policy ?? DEFAULT_SSRF_POLICY };
}

/** 纯字面量判定（不发起网络请求）。 */
export function inspectHost(host: string, options: SsrfOptions = {}): SsrfVerdict {
  return ssrfGuard.inspectHost(host, options);
}

/**
 * 同步 URL 判定（不发起网络请求、不做 DNS 解析）：适合发送前的快速拦截。
 * URL 非法或协议非 HTTP(S) 一律按拦截处理（fail-closed）。
 */
export function inspectUrl(rawUrl: string, options: SsrfOptions = {}): SsrfVerdict {
  return ssrfGuard.inspectUrl(rawUrl, options);
}

/**
 * SSRF 校验：命中即抛错（fail-closed）。
 * 解析失败、协议非 http/https、URL 非法一律按拦截处理——宁可拒绝也不放行。
 */
export async function assertNotSsrf(rawUrl: string, options: SsrfOptions = {}): Promise<void> {
  return ssrfGuard.assertNotSsrf(rawUrl, options);
}
