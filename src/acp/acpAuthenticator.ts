import type { AcpAuthIdentity, AcpAuthMethod, AcpAuthRequest } from './acpProtocol.ts';

/**
 * ACP 认证端口：由宿主决定「有哪些认证方式」以及「method/token 是否有效」。
 *
 * 本仓**不内置任何密钥**，也不猜测凭据来源：`AcpServer` 未注入本端口时
 * `initialize` 的 `authMethods` 为空，`authenticate` 一律拒绝（缺省 fail-closed）。
 * 需要真实认证的嵌入方注入实现（例如比对环境变量、调用身份服务或本地保险库），
 * 返回 `undefined` 表示拒绝；成功时返回的身份会记录到连接与全部活跃会话上。
 */
export interface AcpAuthenticator {
  /** 对外通告的认证方式（initialize 的 authMethods）。 */
  readonly methods: readonly AcpAuthMethod[];
  /**
   * 校验一次 authenticate 请求。
   * @param request 认证方式 id 与可选凭据（`params.token` 原样透传）。
   * @returns 成功时的身份；拒绝时返回 `undefined`。
   */
  authenticate(request: AcpAuthRequest): Promise<AcpAuthIdentity | undefined>;
}
