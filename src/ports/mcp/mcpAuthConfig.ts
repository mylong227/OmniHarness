/**
 * @beta
 * MCP 客户端认证配置（端口层，纯类型）。
 *
 * 本片的口径（2026-10-22）：
 * - `bearer`/`oauth` 都消费**已有访问令牌**（配置值或环境变量），负责把它变成
 *   `Authorization: Bearer …` 请求头；
 * - `oauth` 额外记录资源/授权服务器元数据，供 RFC 9728/8414 发现与后续交互式授权接入；
 * - **不**在本片做浏览器授权码回调（那是下一步的 `mcp auth` 命令）；缺少令牌时 fail-closed，
 *   绝不发匿名请求后静默失败。
 */
export type McpAuthConfig =
  | { readonly type: 'none' }
  | {
      readonly type: 'bearer';
      /** 直接给出的访问令牌（优先级高于 tokenEnv）。 */
      readonly token?: string;
      /** 从环境变量读取令牌的变量名。 */
      readonly tokenEnv?: string;
    }
  | {
      readonly type: 'oauth';
      /** 直接给出的访问令牌（优先级高于 tokenEnv）。 */
      readonly accessToken?: string;
      /** 从环境变量读取令牌的变量名。 */
      readonly tokenEnv?: string;
      /** 受保护资源标识（RFC 8707 `resource`）。 */
      readonly resource?: string;
      /** 授权服务器 issuer（用于 RFC 8414 发现）。 */
      readonly authorizationServer?: string;
      /** 客户端标识（后续交互式授权用）。 */
      readonly clientId?: string;
      /** 申请的 scope。 */
      readonly scopes?: readonly string[];
    };

/** RFC 9728 受保护资源元数据（只建模本仓用到的字段）。 */
export interface McpProtectedResourceMetadata {
  /** 资源标识。 */
  readonly resource: string;
  /** 授权服务器 issuer 列表。 */
  readonly authorizationServers: readonly string[];
  /** 支持的 scope。 */
  readonly scopesSupported?: readonly string[];
  /** 原始元数据（保留未知字段）。 */
  readonly raw: unknown;
}
