/**
 * id_token 校验端口（Wave A.5 · `jose` 准入）。
 *
 * ## 为什么把它抽成端口
 *
 * 本仓原有的企业层实现（`src/enterprise/oidcClient.ts`）是**手写**的 JWT/JWKS 解析与签名校验：
 * 它做了 kid 匹配、`kty` 校验、`crypto.verify` 与 iss/aud/exp/nonce 检查（值得肯定），但存在真实边界：
 *
 * 1. **算法面窄**：只接受 `RS256`，现代 IdP 常见的 `ES256`/`PS256` 一律拒绝（互操作缺口）；
 * 2. **无时钟偏移容忍**：`exp` 与当前时刻直接比较，IdP 与本机轻微漂移即误拒；
 * 3. **`aud` 为数组时不校验 `azp`**：多受众 token 只做 `aud.includes(clientId)`，OIDC 规范要求此时必须核对 `azp`；
 * 4. **手写安全关键解析**：JWT/JWKS/b64url 解析属「不该自己写」的一类（D10「必要且更优」的典型场景）。
 *
 * 端口把「校验 id_token」变成可替换能力：`jose` 实现为主，既有自研实现保留为**回退资产**，
 * 两侧同端口 ⇒ 迁移与回退都**零调用点改动**（A.5 判据要求）。
 *
 * ## 失败语义
 *
 * 一律 `{ok:false, reason}`：**绝不抛裸栈**——校验失败是常规路径（过期、密钥轮换、伪造），
 * 调用方（HTTP 认证中间件）需要的是「拒 + 可读原因」，而不是未捕获异常。
 */

/** id_token 校验请求。 */
export interface IdTokenVerificationRequest {
  /** 待校验的 id_token（`header.payload.signature`）。 */
  readonly token: string;
  /** IdP 的 JWKS 端点（远程，需缓存与轮换处理）。 */
  readonly jwksUrl: string;
  /** 期望签发者（`iss`）。 */
  readonly issuer: string;
  /** 期望受众（`aud`，即 client_id）。 */
  readonly audience: string;
  /** 期望 nonce（登录时下发的值；提供时必须一致）。 */
  readonly nonce?: string | undefined;
  /** 允许的时钟偏移（秒；缺省由实现给保守值）。 */
  readonly clockToleranceSec?: number | undefined;
  /** JWKS 获取超时（毫秒；缺省由实现给保守值）——**必须有界**，否则 IdP 不响应就会悬挂认证。 */
  readonly timeoutMs?: number | undefined;
}

/** id_token 校验结论。 */
export type IdTokenVerification =
  | {
      /** 校验通过。 */
      readonly ok: true;
      /** 受信任的声明集（已通过签名与声明检查）。 */
      readonly claims: Readonly<Record<string, unknown>>;
      /** 实际使用的算法（供审计：本次信任基于哪个 JWS alg）。 */
      readonly algorithm: string;
    }
  | {
      /** 校验被拒（fail-closed）。 */
      readonly ok: false;
      /** 可读原因（进日志；不得含 token 内容本身）。 */
      readonly reason: string;
    };

/** id_token 校验端口。 */
export interface IdTokenVerifierPort {
  /**
   * 校验 id_token（签名 + 声明 + 时间窗）。
   * @param request 校验请求
   * @returns 校验结论（通过给声明；失败给可读原因）
   */
  verify(request: IdTokenVerificationRequest): Promise<IdTokenVerification>;
  /**
   * 本实现接受的 JWS 算法名（**可审计面**：安全评审要能直接问「你们接受哪些 alg」）。
   * 必须显式排除 `none` 与 `HS*`（算法混淆攻击：用公钥充当 HMAC 密钥）。
   * @returns 允许的算法名列表
   */
  allowedAlgorithms(): readonly string[];
}
