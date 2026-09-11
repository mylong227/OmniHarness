/**
 * 网络外联策略门（A5）：纯 TS 实现，allowlist + fail-closed 拒绝。
 *
 * 设计要点：
 * - 默认「开放」：仅当显式配置白名单（--network-allow）时才收紧，避免误伤。
 * - 收紧后「fail-closed」：任何不在白名单的外联地址一律抛 EgressBlockedError，
 *   绝不静默放行。
 * - 接入点：包一层 globalThis.fetch（模型/Web 工具/MCP-SSE 等所有 HTTP 外联的统一咽喉），
 *   在 Agent 运行前安装、运行后还原。
 * - 匹配规则：白名单按「主机后缀」匹配，example.com 同时放行 example.com 与
 *   api.example.com；比对时忽略端口与大小写。
 * - **SSRF 加固**：一旦守卫激活（配置了 --network-allow），私有/链路本地地址
 *   （127.0.0.0/8、10.0.0.0/8、172.16-31.x、192.168.x、169.254.169.254 云元数据、
 *   100.64/10 CGNAT、::1/fe80::/fc00::/fd00::）无论是否在白名单内**一律拒绝**——
 *   白名单只表达「允许的公网主机」，不能用来放行内网地址（防 SSRF 打元数据服务）。
 */
import { EgressBlockedError } from './egressBlockedError.js';




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
}

/**
 * 始终拦截的私有/链路本地地址与主机（SSRF 防护，白名单无法覆盖）。
 * 覆盖：环回、RFC1918 私网、CGNAT(100.64/10)、链路本地(含云元数据 169.254.169.254)、
 * IPv6 ULA(fc00::/fd00::) 与链路本地(fe80::)。
 */
const PRIVATE_HOST_PATTERNS: readonly RegExp[] = [
  /^localhost$/i,
  /\.local$/i,
  /\.internal$/i,
  /\.corp$/i,
  /^(127|10)(\.\d{1,3}){3}$/,
  /^192\.168(\.\d{1,3}){2}$/,
  /^172\.(1[6-9]|2\d|3[01])(\.\d{1,3}){2}$/,
  /^169\.254(\.\d{1,3}){2}$/,
  /^100\.(6[4-9]|[7-9]\d|1[0-1]\d|12[0-7])(\.\d{1,3}){2}$/,
  /^0\.0\.0\.0$/,
  /^::1$/,
  /^fe80:/i,
  /^fc[0-9a-f]{2}:/i,
  /^fd[0-9a-f]{2}:/i,
];

/** 主机是否命中私有/链路本地网段（SSRF 高危）。 */
function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase();
  return PRIVATE_HOST_PATTERNS.some((re) => re.test(h));
}

/** 把任意主机串规整为小写「主机」：去协议、去路径、去端口。 */
function toHost(raw: string): string {
  let host = raw.toLowerCase().replace(/^https?:\/\//, '');
  const slash = host.indexOf('/');
  if (slash >= 0) {
    host = host.slice(0, slash);
  }
  const colon = host.indexOf(':');
  if (colon >= 0) {
    host = host.slice(0, colon);
  }
  return host;
}

/** 网络外联策略门。 */
export class NetworkEgressGuard {
  private readonly allowed: ReadonlySet<string>;
  private readonly blockPrivate: boolean;

  public constructor(options: NetworkEgressOptions) {
    this.allowed = new Set(options.allowedHosts.map(toHost));
    this.blockPrivate = options.blockPrivateRanges ?? true;
  }

  /** 断言 URL 可外联；命中私有网段或不在白名单则抛 EgressBlockedError（fail-closed）。 */
  public assertAllowed(url: string | URL): void {
    const text = this.stringify(url);
    const host = this.hostOf(url);
    if (host !== undefined) {
      // SSRF 优先：私有/链路本地地址（云元数据 169.254.169.254 等）无论白名单一律拒绝。
      if (this.blockPrivate && isPrivateHost(host)) {
        throw new EgressBlockedError(
          `网络外联被 SSRF 策略拒绝（私有/链路本地地址）: ${text}`,
          text,
        );
      }
      if (this.isAllowed(host)) {
        return;
      }
    }
    throw new EgressBlockedError(`网络外联被策略拒绝（不在白名单）: ${text}`, text);
  }

  /** 包一层 fetch：先校验外联地址，再放行原始 fetch。 */
  public wrapFetch(original: typeof fetch): typeof fetch {
    const guard = this;
    return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const anyInput = input as { href?: string; url?: string } | string | URL;
      const url =
        typeof anyInput === 'string'
          ? anyInput
          : anyInput instanceof URL
            ? anyInput.href
            : (anyInput.url ?? anyInput.href ?? '');
      guard.assertAllowed(url);
      return original(input, init);
    }) as typeof fetch;
  }

  /** 主机是否命中白名单（后缀匹配）。 */
  private isAllowed(host: string): boolean {
    const h = host.toLowerCase();
    for (const allowed of this.allowed) {
      if (h === allowed || h.endsWith(`.${allowed}`)) {
        return true;
      }
    }
    return false;
  }

  /** 从输入取主机名（非法 URL 视为未命中）。 */
  private hostOf(url: string | URL): string | undefined {
    try {
      const u = typeof url === 'string' ? new URL(url) : url;
      let hostname = u.hostname;
      // new URL 对 IPv6 返回带方括号的 "[::1]"，剥掉方括号以便私有网段判定统一。
      if (hostname.startsWith('[') && hostname.endsWith(']')) {
        hostname = hostname.slice(1, -1);
      }
      return hostname || undefined;
    } catch {
      return undefined;
    }
  }

  private stringify(url: string | URL): string {
    return typeof url === 'string' ? url : url.href;
  }
}

/** 解析 --network-allow 的逗号分隔主机串为白名单数组（空串返回 []）。 */
export function parseAllowList(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === '') {
    return [];
  }
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}
export { EgressBlockedError };
