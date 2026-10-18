/**
 * 服务端暴露守卫：绑定地址与 Bearer 令牌的**唯一裁决点**。
 *
 * 背景（2026-09-19 审计发现的真缺口）：`httpServer.listen(port)` 未指定地址 ⇒ Node 默认绑
 * `0.0.0.0`，而该服务能驱动 agent 执行任意工具（含 `--auto-approve`）——等于把「无鉴权的
 * 远程代码执行入口」暴露到局域网。本类把规则写死成一处，供 HTTP 路由与 WS 升级共同消费：
 *
 * 1. **默认只绑回环**（127.0.0.1 / ::1 / localhost）；
 * 2. **非回环绑定必须配令牌**，否则拒绝启动（fail-closed，绝不静默开在公网）；
 * 3. 配了令牌后，除 `/healthz`（存活探针，不泄露任何数据）外一律要求
 *    `Authorization: Bearer <token>`，HTTP 与 WebSocket 一视同仁。
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

/** 回环地址集合（含 IPv6 简写与 localhost）。 */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', '::1', 'localhost', '[::1]']);

/** 无需鉴权的路径（存活探针：只回状态与 uptime，不含任何会话/工作区数据）。 */
const PUBLIC_PATHS: ReadonlySet<string> = new Set(['/healthz']);

/** 服务端暴露守卫。 */
export class ServerAuthGuard {
  /** 默认绑定地址（只绑回环：本机单用户是默认形态）。 */
  public static readonly DEFAULT_HOST = '127.0.0.1';

  /** 令牌环境变量名。 */
  public static readonly TOKEN_ENV = 'OMNI_SERVE_TOKEN';

  /** 浏览器同源静态资源/下载使用的会话 cookie 名（HttpOnly，避免把令牌暴露给 JS）。 */
  public static readonly COOKIE_NAME = 'omni_serve_token';

  /** 绑定地址环境变量名。 */
  public static readonly HOST_ENV = 'OMNI_SERVE_HOST';

  /** 期望的令牌（空串表示未启用鉴权）。 */
  private readonly token: string;

  /**
   * @param token 期望令牌（空/未提供表示不启用鉴权；仅在回环绑定时允许）。
   */
  public constructor(token?: string | undefined) {
    this.token = (token ?? '').trim();
  }

  /**
   * 是否启用了令牌鉴权。
   *
   * @returns 启用时为 true。
   */
  public get enabled(): boolean {
    return this.token !== '';
  }

  /**
   * 生成一个高熵临时令牌（仅供本机 serve 进程使用；重启即失效）。
   * @returns 64 位十六进制字符串
   */
  public static generateToken(): string {
    return randomBytes(32).toString('hex');
  }

  /**
   * 构造首次页面响应下发的会话 cookie（HttpOnly + SameSite=Strict）。
   * @param token 服务端令牌
   * @returns Set-Cookie 头值
   */
  public static cookieHeader(token: string): string {
    return `${ServerAuthGuard.COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Strict`;
  }

  /**
   * 该地址是否是回环地址。
   *
   * @param host 绑定地址。
   * @returns 回环时为 true。
   */
  public static isLoopback(host: string): boolean {
    return LOOPBACK_HOSTS.has(host.trim().toLowerCase());
  }

  /**
   * 起服务前的**绑定安全裁决**：非回环绑定必须配令牌。
   *
   * @param host 绑定地址。
   * @param token 令牌（可空）。
   * @throws 非回环且无令牌时抛出可执行的错误（调用方据此拒绝启动）。
   * @returns 无返回值（安全时静默通过）。
   */
  public static assertBindSafe(host: string, token?: string | undefined): void {
    if (ServerAuthGuard.isLoopback(host) || (token ?? '').trim() !== '') {
      return;
    }
    throw new Error(
      `拒绝以 ${host} 启动：非回环绑定必须配令牌（否则等于把可执行任意工具的 RPC 暴露到网络）。` +
        `请设 ${ServerAuthGuard.TOKEN_ENV}=<随机串> 后重试；仅本机使用请保持默认 ${ServerAuthGuard.DEFAULT_HOST}。`,
    );
  }

  /**
   * 校验一条请求是否放行（HTTP 路由与 WS 升级共用）。
   *
   * @param request 原始请求（读 URL 与 Authorization 头）。
   * @returns 放行时为 true。
   */
  public verify(request: IncomingMessage): boolean {
    const url = request.url ?? '/';
    const path = url.split('?')[0] ?? '/';
    if (PUBLIC_PATHS.has(path)) {
      return true;
    }
    // 浏览器跨源防线：本地服务的 RPC/WS 能驱动 agent，任意网页都能向 127.0.0.1 发请求。
    // 无 Origin（CLI/curl）放行；有 Origin 则必须来自回环页面（http(s)://127.0.0.1 / localhost / [::1]）。
    if (!ServerAuthGuard.originAllowed(request)) {
      return false;
    }
    if (!this.enabled) {
      return true;
    }
    // 优先 Authorization 头（fetch / WS 走这条）；SSE 的 EventSource 无法设头，
    // 退化为 URL 查询参数 ?token=（同源 Bearer 令牌，值等价，故复用同一 matches）。
    const header = request.headers['authorization'];
    if (typeof header === 'string' && ServerAuthGuard.matches(header, this.token)) {
      return true;
    }
    const queryToken = ServerAuthGuard.tokenFromQuery(url);
    if (queryToken !== null && ServerAuthGuard.matches(`Bearer ${queryToken}`, this.token)) {
      return true;
    }
    // 静态资源/下载/WS 由浏览器自动带同源 cookie；令牌本身仍是 HttpOnly，JS 读不到。
    const cookieToken = ServerAuthGuard.tokenFromCookie(request);
    if (cookieToken !== null && ServerAuthGuard.matches(`Bearer ${cookieToken}`, this.token)) {
      return true;
    }
    return false;
  }

  /**
   * 校验请求的 `Origin`（仅在浏览器会带；无 Origin 视为非浏览器客户端）。
   * @param request 原始请求
   * @returns 无 Origin 或 Origin 为回环 http(s) 页面时为 true
   */
  private static originAllowed(request: IncomingMessage): boolean {
    const origin = request.headers['origin'];
    if (origin === undefined) return true;
    if (typeof origin !== 'string') return false;
    try {
      const url = new URL(origin);
      return (
        (url.protocol === 'http:' || url.protocol === 'https:') &&
        ServerAuthGuard.isLoopback(url.hostname)
      );
    } catch {
      return false;
    }
  }

  /**
   * 常量时间比较 `Bearer <token>`（避免按字符提前返回导致的时序侧信道）。
   *
   * @param header Authorization 头原文。
   * @param token 期望令牌。
   * @returns 匹配时为 true。
   */
  private static matches(header: string, token: string): boolean {
    const prefix = 'Bearer ';
    if (!header.startsWith(prefix)) {
      return false;
    }
    const provided = Buffer.from(header.slice(prefix.length).trim(), 'utf8');
    const expected = Buffer.from(token, 'utf8');
    if (provided.length !== expected.length) {
      return false;
    }
    return timingSafeEqual(provided, expected);
  }

  /**
   * 从请求 URL 的查询参数中取 `token`（SSE 鉴权专用：EventSource 无法带 Authorization 头）。
   * @param url 原始请求 URL（含查询串）。
   * @returns 令牌原文；不存在或无法解析时返回 null。
   */
  private static tokenFromQuery(url: string): string | null {
    const q = url.indexOf('?');
    if (q === -1) {
      return null;
    }
    try {
      return new URLSearchParams(url.slice(q + 1)).get('token');
    } catch {
      return null;
    }
  }

  /**
   * 从 Cookie 头取会话令牌。
   * @param request 原始请求
   * @returns 令牌原文；不存在时返回 null
   */
  private static tokenFromCookie(request: IncomingMessage): string | null {
    const header = request.headers.cookie;
    if (typeof header !== 'string') return null;
    for (const part of header.split(';')) {
      const eq = part.indexOf('=');
      if (eq === -1) continue;
      if (part.slice(0, eq).trim() !== ServerAuthGuard.COOKIE_NAME) continue;
      return part.slice(eq + 1).trim();
    }
    return null;
  }
}
