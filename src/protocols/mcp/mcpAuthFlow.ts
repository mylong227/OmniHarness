/**
 * MCP OAuth 授权码 + PKCE 回环流程（2026-10-22，P0-3 第四片）。
 *
 * 只监听 `127.0.0.1` 随机端口；打印授权 URL 由调用方决定（CLI 打印/打开浏览器），
 * 回调校验 state、换令牌、写 `McpAuthTokenStore`。不自动打开浏览器（无隐藏副作用）。
 */
import { createServer, type Server } from 'node:http';
import { McpOAuthPkce, type OAuthCallback } from './mcpOAuthPkce.ts';
import { McpOAuthTokenClient } from './mcpOAuthTokenClient.ts';
import { McpAuthTokenStore, type McpStoredToken } from './mcpAuthTokenStore.ts';
import { McpCimd } from './mcpCimd.ts';

/** 流程选项。 */
export interface McpAuthFlowOptions {
  /** 授权端点。 */
  readonly authorizeUrl: string;
  /** 令牌端点。 */
  readonly tokenUrl: string;
  /** 客户端标识。 */
  readonly clientId: string;
  /** 受保护资源（RFC 8707，同时作为令牌存储键）。 */
  readonly resource: string;
  /**
   * 记录在案的授权服务器 issuer（RFC 8414；缺省取 authorizeUrl 的 origin）。
   * 回调里的 `iss`（RFC 9207）存在时必须与之逐字相等，否则拒绝兑换授权码。
   */
  readonly issuer?: string | undefined;
  /** 是否要求授权响应必须带 `iss`（缺省 false；开启后缺 iss 即拒绝）。 */
  readonly requireIssuer?: boolean | undefined;
  /** 申请的 scope。 */
  readonly scopes?: readonly string[] | undefined;
  /** 回环端口（缺省 0 = 系统分配）。 */
  readonly port?: number | undefined;
  /** 等待回调超时（毫秒，缺省 5 分钟）。 */
  readonly timeoutMs?: number | undefined;
  /** 授权 URL 回调（CLI 打印/打开浏览器）。 */
  readonly onAuthorizeUrl: (url: string) => void;
  /** 令牌存储（缺省默认路径）。 */
  readonly tokenStore?: McpAuthTokenStore | undefined;
  /** 时钟注入。 */
  readonly now?: number | undefined;
  /** fetch 注入（CIMD / 测试）。 */
  readonly fetchImpl?: typeof fetch | undefined;
}

/**
 * 授权码 + PKCE 回环流程。
 */
export class McpAuthFlow {
  /**
   * 跑完一次授权，返回并持久化令牌。
   * @param options 端点/客户端/资源/回调。
   * @returns 令牌。
   */
  public static async run(options: McpAuthFlowOptions): Promise<McpStoredToken> {
    const pkce = McpOAuthPkce.create();
    const state = McpOAuthPkce.state();
    const issuer = options.issuer ?? new URL(options.authorizeUrl).origin;
    const server = createServer();
    const port = await McpAuthFlow.listen(server, options.port ?? 0);
    const redirectUri = `http://127.0.0.1:${String(port)}/callback`;
    try {
      if (McpCimd.isCimd(options.clientId)) {
        const metadata = await McpCimd.resolve(options.clientId, options.fetchImpl ?? fetch);
        if (!metadata.redirectUris.includes(redirectUri)) {
          throw new Error(`CIMD 未登记回调地址: ${redirectUri}`);
        }
      }
      const authorizeUrl = McpOAuthPkce.authorizationUrl({
        authorizationEndpoint: options.authorizeUrl,
        clientId: options.clientId,
        redirectUri,
        challenge: pkce.challenge,
        state,
        ...(options.scopes !== undefined ? { scopes: options.scopes } : {}),
        resource: options.resource,
      });
      options.onAuthorizeUrl(authorizeUrl);
      const callback = await McpAuthFlow.waitForCode(server, state, options.timeoutMs ?? 300_000);
      const code = McpAuthFlow.codeOf(callback, issuer, options.requireIssuer === true);
      const token = await McpOAuthTokenClient.authorizationCode(
        {
          tokenEndpoint: options.tokenUrl,
          clientId: options.clientId,
          code,
          redirectUri,
          codeVerifier: pkce.verifier,
          resource: options.resource,
        },
        options.now ?? Date.now(),
      );
      const stored: McpStoredToken = {
        accessToken: token.accessToken,
        expiresAt: token.expiresAt,
        tokenEndpoint: options.tokenUrl,
        clientId: options.clientId,
        resource: options.resource,
        issuer,
        ...(token.refreshToken !== undefined ? { refreshToken: token.refreshToken } : {}),
        ...(options.scopes !== undefined ? { scopes: options.scopes } : {}),
      };
      (
        options.tokenStore ??
        new McpAuthTokenStore(process.env.OMNI_MCP_TOKENS_FILE ?? McpAuthTokenStore.defaultPath())
      ).set(stored);
      return stored;
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  /**
   * 监听回环端口。
   * @param server http server。
   * @param port 端口（0 = 自动）。
   * @returns 实际端口。
   */
  private static async listen(server: Server, port: number): Promise<number> {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('MCP auth 回环服务器没有端口');
    }
    return address.port;
  }

  /**
   * 等回调并校验 state。
   * @param server http server。
   * @param expectedState 期望 state。
   * @param timeoutMs 超时。
   * @returns 回调参数（code/state/iss/error）。
   */
  private static async waitForCode(
    server: Server,
    expectedState: string,
    timeoutMs: number,
  ): Promise<OAuthCallback> {
    return await new Promise<OAuthCallback>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`MCP auth 等待回调超时（${String(timeoutMs)}ms）`));
      }, timeoutMs);
      timer.unref?.();
      server.on('request', (request, response) => {
        const callback = McpOAuthPkce.parseCallback(`http://127.0.0.1${request.url ?? '/'}`);
        response.setHeader('content-type', 'text/html; charset=utf-8');
        if (callback.error !== undefined) {
          response.end('<h1>授权失败</h1><p>可以关闭此页。</p>');
          clearTimeout(timer);
          reject(new Error(`MCP auth 授权失败: ${callback.error}`));
          return;
        }
        if (callback.state !== expectedState) {
          response.statusCode = 400;
          response.end('<h1>state 不匹配</h1>');
          clearTimeout(timer);
          reject(new Error('MCP auth state 不匹配（拒绝回调）'));
          return;
        }
        if (callback.code === undefined || callback.code === '') {
          response.statusCode = 400;
          response.end('<h1>缺少 code</h1>');
          clearTimeout(timer);
          reject(new Error('MCP auth 回调缺少 code'));
          return;
        }
        response.end('<h1>授权成功</h1><p>可以关闭此页。</p>');
        clearTimeout(timer);
        resolve(callback);
      });
    });
  }

  /**
   * 校验回调的 issuer（RFC 9207）并返回授权码。
   *
   * 规范：客户端 **MUST** 校验「存在的 `iss`」与记录在案的 issuer 一致；
   * `requireIssuer` 开启时，缺失 `iss` 同样拒绝（更严格的部署口径）。
   * @param callback 回调参数。
   * @param expectedIssuer 记录在案的 issuer。
   * @param requireIssuer 是否要求 iss 必须存在。
   * @returns 授权码。
   * @throws issuer 缺失（严格模式）/不匹配时抛错（不发起令牌兑换）。
   */
  private static codeOf(
    callback: OAuthCallback,
    expectedIssuer: string,
    requireIssuer: boolean,
  ): string {
    if (callback.iss === undefined) {
      if (requireIssuer) {
        throw new Error('MCP auth 授权响应缺少 iss（RFC 9207 严格模式拒绝）');
      }
    } else if (callback.iss !== expectedIssuer) {
      throw new Error('MCP auth 授权响应的 iss 与记录的 issuer 不一致（拒绝兑换授权码）');
    }
    const code = callback.code;
    if (code === undefined || code === '') {
      throw new Error('MCP auth 回调缺少 code');
    }
    return code;
  }
}
