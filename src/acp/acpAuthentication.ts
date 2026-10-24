import type { AcpAuthenticator } from './acpAuthenticator.ts';
import { ACP_ERROR_AUTH_REQUIRED, ACP_ERROR_INVALID_PARAMS } from './acpProtocol.ts';
import type { AcpAuthIdentity, AcpAuthMethod } from './acpProtocol.ts';
import { AcpRequestError } from './acpRequestError.ts';
import type { AcpSessionRegistry } from './acpSessionRegistry.ts';
import { AcpValidation } from './acpValidation.ts';

/**
 * ACP 认证状态（**单连接**）：认证方式通告、authenticate/logout 与 `requireAuth` 门禁。
 *
 * 本类不内置任何凭据：校验完全委托给构造时注入的 `AcpAuthenticator`；没有端口时
 * `methods()` 为空且 `authenticate` 一律拒绝。认证成功后的身份会同步写到
 * `AcpSessionRegistry` 中的全部活跃会话，供运行时工厂读取。
 */
export class AcpAuthentication {
  /** 认证端口（undefined = 不提供认证方式）。 */
  private readonly authenticator: AcpAuthenticator | undefined;
  /** 是否要求先认证。 */
  private readonly requireAuth: boolean;
  /** 活跃会话表（身份传播目标）。 */
  private readonly registry: AcpSessionRegistry;
  /** 对外通告的认证方式。 */
  private readonly authMethods: readonly AcpAuthMethod[];
  /** 当前连接的身份。 */
  private identity: AcpAuthIdentity | undefined;

  /**
   * @param authenticator 认证端口（可缺省）。
   * @param requireAuth 是否要求先认证。
   * @param registry 活跃会话表（认证成功时传播身份）。
   */
  public constructor(
    authenticator: AcpAuthenticator | undefined,
    requireAuth: boolean,
    registry: AcpSessionRegistry,
  ) {
    this.authenticator = authenticator;
    this.requireAuth = requireAuth;
    this.registry = registry;
    this.authMethods = authenticator?.methods ?? [];
    this.identity = undefined;
  }

  /**
   * 对外通告的认证方式（initialize 的 authMethods）。
   * @returns 认证方式（无端口时为空数组）。
   */
  public methods(): readonly AcpAuthMethod[] {
    return this.authMethods;
  }

  /**
   * 是否对外通告了至少一种认证方式。
   * @returns 有可通告方式时为 true。
   */
  public hasMethods(): boolean {
    return this.authMethods.length > 0;
  }

  /**
   * 当前连接的身份。
   * @returns 身份；未认证时为 undefined。
   */
  public currentIdentity(): AcpAuthIdentity | undefined {
    return this.identity;
  }

  /**
   * authenticate：校验 methodId（以及可选的 token），成功后记录身份并传播到活跃会话。
   * @param params 请求参数（methodId 必填；token 可选，原样交给认证端口）。
   * @returns 空对象。
   */
  public async authenticate(params: unknown): Promise<unknown> {
    const record = AcpValidation.recordOf(params);
    const methodId = AcpValidation.requireString(record, 'methodId');
    const authenticator = this.authenticator;
    if (authenticator === undefined || !this.hasMethod(methodId)) {
      throw new AcpRequestError(`未知认证方式: ${methodId}`, ACP_ERROR_INVALID_PARAMS);
    }
    const rawToken = record['token'];
    const token = typeof rawToken === 'string' && rawToken !== '' ? rawToken : undefined;
    const identity = await authenticator.authenticate({
      methodId,
      ...(token !== undefined ? { token } : {}),
    });
    if (identity === undefined) {
      throw new AcpRequestError('认证失败：method/token 无效', ACP_ERROR_AUTH_REQUIRED);
    }
    this.identity = identity;
    this.registry.applyIdentity(identity);
    return {};
  }

  /**
   * logout：清除连接与全部活跃会话上的身份（幂等）。
   * @returns 空对象。
   */
  public logout(): unknown {
    this.identity = undefined;
    this.registry.clearIdentity();
    return {};
  }

  /**
   * 未认证时的门禁（`requireAuth` 缺省关闭以保持既有 Client 兼容）。
   * @returns 无返回值。
   * @throws AcpRequestError 需要认证但当前连接未认证时抛出（-32000）。
   */
  public require(): void {
    if (!this.requireAuth || this.identity !== undefined) return;
    throw new AcpRequestError('需要先 authenticate', ACP_ERROR_AUTH_REQUIRED);
  }

  /**
   * 判断 methodId 是否在已通告的方式中。
   * @param methodId 认证方式 id。
   * @returns 已通告时为 true。
   */
  private hasMethod(methodId: string): boolean {
    return this.authMethods.some((item) => item.id === methodId);
  }
}
