/**
 * 出站 egress 策略（2026-10-22，P1-6 第一片）。
 *
 * `web_fetch` 这类模型可控的出站请求必须过一道**默认拒绝内网/元数据**的地板，并可选
 * 主机/端口允许清单。它不替代 OS 防火墙，而是把「模型给出的 URL」收窄到可复核范围。
 *
 * 环境变量：
 * - `OMNI_EGRESS_ALLOW_PRIVATE=1`：允许私有网段（本机 Ollama/本地服务场景，显式开）；
 * - `OMNI_EGRESS_ALLOW_HOSTS=a.com,.b.com`：非空时只允许精确/后缀命中；
 * - `OMNI_EGRESS_ALLOW_PORTS=80,443`：非空时只允许这些端口。
 */
import { SsrfGuard, type SsrfOptions } from './ssrfGuard.ts';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/** 出站判定。 */
export type EgressVerdict =
  { readonly blocked: false } | { readonly blocked: true; readonly reason: string };

/** 出站策略选项。 */
export interface EgressPolicyOptions {
  /** 覆盖环境（测试）。 */
  readonly env?: Record<string, string | undefined> | undefined;
  /** 覆盖 SSRF 选项（测试）。 */
  readonly ssrf?: SsrfOptions | undefined;
  /** DNS 解析注入（测试）。 */
  readonly lookup?: ((host: string) => Promise<readonly string[]>) | undefined;
}

/**
 * 出站策略（纯同步判定，无 IO）。
 */
export class EgressPolicy {
  /**
   * 判定 URL 是否允许出站。
   * @param rawUrl 目标 URL。
   * @param options 环境/SSRF 覆盖。
   * @returns 允许或拒绝原因。
   */
  public static check(rawUrl: string, options: EgressPolicyOptions = {}): EgressVerdict {
    const env = options.env ?? process.env;
    const url = EgressPolicy.parse(rawUrl);
    if (url === undefined) return { blocked: true, reason: `非法 URL（${rawUrl}）` };
    if (url.username !== '' || url.password !== '') {
      return { blocked: true, reason: 'URL 不得内嵌用户名/密码' };
    }
    const ssrf = new SsrfGuard().inspectUrl(
      url.href,
      options.ssrf ?? {
        allowPrivate: env['OMNI_EGRESS_ALLOW_PRIVATE'] === '1',
        allowMetadata: false,
      },
    );
    if (ssrf.blocked) return { blocked: true, reason: ssrf.reason };
    const hosts = EgressPolicy.list(env['OMNI_EGRESS_ALLOW_HOSTS']);
    if (hosts.length > 0) {
      const host = url.hostname.toLowerCase();
      const allowed = hosts.some((entry) =>
        entry.startsWith('.') ? host.endsWith(entry) || host === entry.slice(1) : host === entry,
      );
      if (!allowed) return { blocked: true, reason: `主机不在 egress 允许清单: ${host}` };
    }
    const ports = EgressPolicy.list(env['OMNI_EGRESS_ALLOW_PORTS']).map(Number);
    if (ports.length > 0) {
      const port = Number(url.port === '' ? (url.protocol === 'https:' ? '443' : '80') : url.port);
      if (!ports.includes(port))
        return { blocked: true, reason: `端口不在 egress 允许清单: ${port}` };
    }
    return { blocked: false };
  }

  /**
   * 判定 URL（含 DNS 解析）：域名解析出的任一 IP 命中内网/元数据即拒绝。
   * @param rawUrl 目标 URL。
   * @param options 环境/DNS 覆盖。
   * @returns 允许或拒绝原因。
   */
  public static async checkAsync(
    rawUrl: string,
    options: EgressPolicyOptions = {},
  ): Promise<EgressVerdict> {
    const sync = EgressPolicy.check(rawUrl, options);
    if (sync.blocked) return sync;
    const url = EgressPolicy.parse(rawUrl);
    if (url === undefined) return { blocked: true, reason: `非法 URL（${rawUrl}）` };
    const host = url.hostname.replace(/\.$/u, '');
    if (isIP(host) !== 0) return { blocked: false };
    let addresses: readonly string[];
    try {
      addresses =
        options.lookup !== undefined
          ? await options.lookup(host)
          : (await lookup(host, { all: true, verbatim: true })).map((entry) => entry.address);
    } catch {
      return { blocked: true, reason: `DNS 解析失败（fail-closed）: ${host}` };
    }
    const env = options.env ?? process.env;
    const ssrfOptions: SsrfOptions = options.ssrf ?? {
      allowPrivate: env['OMNI_EGRESS_ALLOW_PRIVATE'] === '1',
      allowMetadata: false,
    };
    for (const address of addresses) {
      const verdict = new SsrfGuard().inspectHost(address, ssrfOptions);
      if (verdict.blocked) return { blocked: true, reason: verdict.reason };
    }
    if (addresses.length === 0) {
      return { blocked: true, reason: `DNS 无地址（fail-closed）: ${host}` };
    }
    return { blocked: false };
  }

  /**
   * 解析 URL。
   * @param rawUrl 原始 URL。
   * @returns 合法 http(s) URL；否则 undefined。
   */
  private static parse(rawUrl: string): URL | undefined {
    try {
      const url = new URL(rawUrl);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
      return url;
    } catch {
      return undefined;
    }
  }

  /**
   * 逗号分隔列表（去空白、小写）。
   * @param value 原始值。
   * @returns 规范化条目。
   */
  private static list(value: string | undefined): string[] {
    if (value === undefined || value.trim() === '') return [];
    return value
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry !== '');
  }
}
