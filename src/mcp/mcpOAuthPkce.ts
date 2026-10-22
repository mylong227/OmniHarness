/**
 * MCP OAuth PKCE 工具（2026-10-22，P0-3 第三片）。
 *
 * 只做**纯协议**：生成 verifier/challenge/state、拼授权 URL、解析回调。
 * 浏览器打开与本地回调服务器仍由后续 `mcp auth` 命令接线；本类不触网、不落盘。
 */
import { createHash, randomBytes } from 'node:crypto';

/** PKCE 对（RFC 7636；本仓固定 S256）。 */
export interface PkcePair {
  /** 高熵 verifier（base64url，43..128 字符）。 */
  readonly verifier: string;
  /** S256 challenge。 */
  readonly challenge: string;
  /** 固定 S256。 */
  readonly method: 'S256';
}

/** 授权 URL 参数。 */
export interface AuthorizationUrlOptions {
  readonly authorizationEndpoint: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly challenge: string;
  readonly state: string;
  readonly scopes?: readonly string[] | undefined;
  /** RFC 8707 resource。 */
  readonly resource?: string | undefined;
}

/** 回调解析结果。 */
export interface OAuthCallback {
  readonly code?: string | undefined;
  readonly state?: string | undefined;
  readonly error?: string | undefined;
  readonly errorDescription?: string | undefined;
}

/** PKCE 纯工具。 */
export class McpOAuthPkce {
  /** verifier 字节数（32 bytes → 43 个 base64url 字符）。 */
  private static readonly VERIFIER_BYTES = 32;

  /** verifier 合法字符集。 */
  private static readonly VERIFIER_PATTERN = /^[A-Za-z0-9\-._~]{43,128}$/u;

  /**
   * 生成 verifier/challenge。
   * @param bytes 随机字节注入（测试用；缺省 crypto.randomBytes(32)）。
   * @returns PKCE 对。
   */
  public static create(bytes: Buffer = randomBytes(McpOAuthPkce.VERIFIER_BYTES)): PkcePair {
    const verifier = McpOAuthPkce.base64Url(bytes);
    return {
      verifier,
      challenge: McpOAuthPkce.challengeOf(verifier),
      method: 'S256',
    };
  }

  /**
   * 计算 S256 challenge（RFC 7636 附录 B 向量）。
   * @param verifier 已生成的 verifier。
   * @returns base64url(sha256(verifier))。
   */
  public static challengeOf(verifier: string): string {
    return McpOAuthPkce.base64Url(createHash('sha256').update(verifier, 'ascii').digest());
  }

  /**
   * 生成 state（防 CSRF；32 bytes base64url）。
   * @param bytes 随机字节注入（测试用）。
   * @returns state。
   */
  public static state(bytes: Buffer = randomBytes(McpOAuthPkce.VERIFIER_BYTES)): string {
    return McpOAuthPkce.base64Url(bytes);
  }

  /**
   * 拼授权 URL（response_type=code，S256）。
   * @param options 端点/客户端/回调/PKCE/state/scope/resource。
   * @returns 授权 URL。
   */
  public static authorizationUrl(options: AuthorizationUrlOptions): string {
    const url = new URL(options.authorizationEndpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', options.clientId);
    url.searchParams.set('redirect_uri', options.redirectUri);
    url.searchParams.set('code_challenge', options.challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('state', options.state);
    if (options.scopes !== undefined && options.scopes.length > 0) {
      url.searchParams.set('scope', options.scopes.join(' '));
    }
    if (options.resource !== undefined) {
      url.searchParams.set('resource', options.resource);
    }
    return url.href;
  }

  /**
   * 解析回调 URL（只读 query；不校验 state，调用方必须比对）。
   * @param callbackUrl 回调 URL。
   * @returns code/state/error。
   */
  public static parseCallback(callbackUrl: string): OAuthCallback {
    const url = new URL(callbackUrl);
    const code = url.searchParams.get('code') ?? undefined;
    const state = url.searchParams.get('state') ?? undefined;
    const error = url.searchParams.get('error') ?? undefined;
    const errorDescription = url.searchParams.get('error_description') ?? undefined;
    return {
      ...(code !== undefined ? { code } : {}),
      ...(state !== undefined ? { state } : {}),
      ...(error !== undefined ? { error } : {}),
      ...(errorDescription !== undefined ? { errorDescription } : {}),
    };
  }

  /**
   * 校验 verifier 形态（生成侧断言/测试用）。
   * @param verifier 待校验值。
   * @returns 合法时为 true。
   */
  public static isVerifier(verifier: string): boolean {
    return McpOAuthPkce.VERIFIER_PATTERN.test(verifier);
  }

  /**
   * base64url 无填充。
   * @param bytes 原始字节。
   * @returns base64url 字符串。
   */
  private static base64Url(bytes: Buffer): string {
    return bytes.toString('base64').replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
  }
}
