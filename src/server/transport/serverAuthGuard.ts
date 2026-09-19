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
import { timingSafeEqual } from 'node:crypto';
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
    if (!this.enabled) {
      return true;
    }
    const path = (request.url ?? '/').split('?')[0] ?? '/';
    if (PUBLIC_PATHS.has(path)) {
      return true;
    }
    const header = request.headers['authorization'];
    if (typeof header !== 'string') {
      return false;
    }
    return ServerAuthGuard.matches(header, this.token);
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
}
