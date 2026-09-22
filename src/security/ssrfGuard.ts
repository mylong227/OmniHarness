import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

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
  /** 是否做 DNS 解析后二次判定（默认 false：解析有网络开销且引入 TOCTOU 窗口）。 */
  readonly resolveDns?: boolean;
}

/** SSRF 拦截原因。 */
export type SsrfVerdict =
  { readonly blocked: false } | { readonly blocked: true; readonly reason: string };

/**
 * SSRF 防护引擎：云元数据/私有网段/非法字面量判定，fail-closed。
 */
export class SsrfGuard {
  /** 云元数据地址（各厂商链路本地地址，必须拦截）。 */
  private static readonly METADATA_HOSTS = new Set([
    '169.254.169.254',
    '100.100.100.200',
    'metadata.google.internal',
    'metadata.goog',
  ]);

  /** 内网/本机域名后缀模式。 */
  private static readonly INTERNAL_SUFFIXES = [
    '.localhost',
    '.local',
    '.internal',
    '.intranet',
    '.lan',
  ];

  /** IPv4 私有/保留网段（CIDR 列表）。 */
  private static readonly IPV4_BLOCKS: readonly (readonly [string, number])[] = [
    ['0.0.0.0', 8], // 本网络
    ['10.0.0.0', 8], // 私有
    ['100.64.0.0', 10], // CGNAT
    ['127.0.0.0', 8], // 环回
    ['169.254.0.0', 16], // 链路本地（含云元数据）
    ['172.16.0.0', 12], // 私有
    ['192.0.0.0', 24], // IETF 协议分配
    ['192.168.0.0', 16], // 私有
    ['198.18.0.0', 15], // 基准测试
    ['224.0.0.0', 4], // 组播
    ['240.0.0.0', 4], // 保留（含 255.255.255.255）
  ];

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

  /** IPv4 点分十进制转 32 位整数（非法输入返回 null）。 */
  private ipv4ToInt(ip: string): number | null {
    const parts = ip.split('.');
    if (parts.length !== 4) {
      return null;
    }
    let value = 0;
    for (const part of parts) {
      if (!/^\d{1,3}$/.test(part)) {
        return null;
      }
      const n = Number(part);
      if (n > 255) {
        return null;
      }
      value = value * 256 + n;
    }
    return value;
  }

  /** IPv4 是否落在屏蔽网段内。 */
  private isBlockedIpv4(ip: string): boolean {
    const value = this.ipv4ToInt(ip);
    if (value === null) {
      return true;
    }
    for (const [base, bits] of SsrfGuard.IPV4_BLOCKS) {
      const baseValue = this.ipv4ToInt(base);
      if (baseValue === null) {
        continue;
      }
      const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
      if ((value & mask) >>> 0 === (baseValue & mask) >>> 0) {
        return true;
      }
    }
    return false;
  }

  /** IPv6 是否属于需屏蔽的本机/私有地址。 */
  private isBlockedIpv6(ip: string): boolean {
    const lower = ip.toLowerCase().replace(/^\[|\]$/g, '');
    if (lower === '::1' || lower === '::') {
      return true;
    }
    // 内嵌 IPv4 的三种 IPv6 形态一律按其内嵌 IPv4 判定（2026-09-22 修）：
    // IPv4-mapped `::ffff:a.b.c.d`、IPv4-compatible `::a.b.c.d`、NAT64 `64:ff9b::/96`、6to4 `2002::/16`。
    // 此前只认 `::ffff:` 的**点分**写法，于是 `http://[::ffff:169.254.169.254]/`、
    // `[::ffff:7f00:1]`、`[0:0:0:0:0:ffff:a9fe:a9fe]` 全部绕过「云元数据永远拦截」的声明（已实测复现）。
    const embedded = this.embeddedIpv4(lower);
    if (embedded !== null) {
      return this.isBlockedIpv4(embedded);
    }
    const groups = SsrfGuard.parseIpv6Groups(lower);
    if (groups === null) {
      return true; // 解析不了 ⇒ fail-closed（原实现是前缀启发式，宁可拦错不可漏放）
    }
    const h0 = groups[0] ?? 0;
    if ((h0 & 0xfe00) === 0xfc00) {
      return true; // fc00::/7 唯一本地
    }
    if ((h0 & 0xffc0) === 0xfe80) {
      return true; // fe80::/10 链路本地
    }
    if ((h0 & 0xff00) === 0xff00) {
      return true; // ff00::/8 组播
    }
    return false;
  }

  /**
   * 从 IPv6 字面量中取出**内嵌的 IPv4**（点分十进制）；无内嵌返回 null。
   *
   * 覆盖：`::ffff:0:0/96`（IPv4-mapped，含点分与十六进制两种写法）、`::/96`（IPv4-compatible）、
   * `64:ff9b::/96`（NAT64）、`2002::/16`（6to4）。安全性优先于完备性：宁可多判一层。
   * @param ip 已去方括号、已小写的 IPv6 字面量
   * @returns 内嵌 IPv4 的点分十进制形式；无内嵌或不可解析时为 null
   */
  private embeddedIpv4(ip: string): string | null {
    const groups = SsrfGuard.parseIpv6Groups(SsrfGuard.expandTrailingIpv4(ip));
    if (groups === null) {
      return null;
    }
    const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = groups;
    const dotted = (hi: number, lo: number): string =>
      `${String(hi >> 8)}.${String(hi & 0xff)}.${String(lo >> 8)}.${String(lo & 0xff)}`;
    const mapped =
      g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && (g5 === 0xffff || g5 === 0);
    if (mapped) {
      return dotted(g6, g7);
    }
    if (g0 === 0x64 && g1 === 0xff9b) {
      return dotted(g6, g7); // NAT64
    }
    if (g0 === 0x2002) {
      return dotted(g1, g2); // 6to4
    }
    return null;
  }

  /**
   * 把「尾部点分 IPv4」的混合写法展开为纯十六进制分组（`::ffff:169.254.169.254` → `::ffff:a9fe:a9fe`）。
   * 该类写法是 URL 中的常见形态（`http://[::ffff:169.254.169.254]/`），不展开会被解析器判为非法分组。
   * @param ip IPv6 字面量（可能带点分尾巴）
   * @returns 纯十六进制 IPv6 字面量；无点分尾巴或数值非法时原样返回
   */
  private static expandTrailingIpv4(ip: string): string {
    const m = /^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
    if (m === null) {
      return ip;
    }
    const nums = [m[2], m[3], m[4], m[5]].map((x) => Number(x));
    if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
      return ip;
    }
    const hi = ((nums[0] ?? 0) * 256 + (nums[1] ?? 0)).toString(16);
    const lo = ((nums[2] ?? 0) * 256 + (nums[3] ?? 0)).toString(16);
    return `${m[1] ?? ''}${hi}:${lo}`;
  }

  /**
   * 解析 IPv6 为 8 组 16 位整数（支持 `::` 缩写与 `%zone` 后缀）。
   * @param ip IPv6 字面量
   * @returns 8 组整数；不可解析返回 null
   */
  private static parseIpv6Groups(ip: string): number[] | null {
    const clean = (ip.split('%')[0] ?? ip).toLowerCase();
    const halves = clean.split('::');
    if (halves.length > 2) {
      return null;
    }
    const parseSide = (part: string): number[] | null => {
      if (part === '') {
        return [];
      }
      const out: number[] = [];
      for (const group of part.split(':')) {
        if (!/^[0-9a-f]{1,4}$/.test(group)) {
          return null;
        }
        out.push(Number.parseInt(group, 16));
      }
      return out;
    };
    const left = parseSide(halves[0] ?? '');
    const right = parseSide(halves.length === 2 ? (halves[1] ?? '') : '');
    if (left === null || right === null) {
      return null;
    }
    if (halves.length === 1) {
      return left.length === 8 ? left : null;
    }
    const fill = 8 - left.length - right.length;
    if (fill < 0) {
      return null;
    }
    return [...left, ...new Array<number>(fill).fill(0), ...right];
  }

  /** 纯字面量判定（不发起网络请求）。 */
  public inspectHost(host: string, options: SsrfOptions = {}): SsrfVerdict {
    const lower = host.toLowerCase().replace(/^\[|\]$/g, '');
    if (lower === '') {
      return { blocked: true, reason: '空主机名' };
    }
    // 元数据判定必须同时覆盖「IPv6 内嵌 IPv4」的写法（否则 [::ffff:169.254.169.254] 绕过
    // 「元数据永远拦截」——2026-09-22 实测复现并修复）。
    const embedded = isIP(lower) === 6 ? this.embeddedIpv4(lower) : null;
    if (
      options.allowMetadata !== true &&
      (SsrfGuard.METADATA_HOSTS.has(lower) ||
        (embedded !== null && SsrfGuard.METADATA_HOSTS.has(embedded)))
    ) {
      return { blocked: true, reason: `云元数据地址被拦截: ${host}` };
    }
    if (lower === 'localhost' || SsrfGuard.INTERNAL_SUFFIXES.some((s) => lower.endsWith(s))) {
      return { blocked: true, reason: `本机/内网域名被拦截: ${host}` };
    }
    const version = isIP(lower);
    if (version === 4) {
      if (options.allowPrivate === true) {
        return { blocked: false };
      }
      return this.isBlockedIpv4(lower)
        ? { blocked: true, reason: `私有/保留 IPv4 被拦截: ${host}` }
        : { blocked: false };
    }
    if (version === 6) {
      if (options.allowPrivate === true) {
        return { blocked: false };
      }
      return this.isBlockedIpv6(lower)
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
