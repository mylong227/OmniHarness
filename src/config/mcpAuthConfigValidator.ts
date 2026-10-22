/**
 * MCP 认证配置校验（2026-10-22）。
 *
 * 从 `configError.ts` 外移：该文件已到 810 行铁律上限；校验逻辑独立成类，
 * 也便于将来与 OAuth 交互式授权配置复用同一份白名单。
 *
 * 本类只返回错误消息，不抛 `ConfigError`——避免 `configError ↔ validator` 的循环依赖。
 */

/** MCP `auth` 段校验器。 */
export class McpAuthConfigValidator {
  /**
   * 校验认证段（fail-closed；未知 type/字段类型错一律拒绝）。
   * @param raw 原始 auth 值。
   * @param where 诊断位置。
   * @returns 错误消息；合法为 undefined。
   */
  public static validate(raw: unknown, where: string): string | undefined {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return `${where} 必须是对象`;
    }
    const auth = raw as Record<string, unknown>;
    const type = auth['type'];
    if (type !== 'none' && type !== 'bearer' && type !== 'oauth') {
      return `${where}.type 必须是 none/bearer/oauth`;
    }
    const allowed: Readonly<Record<'none' | 'bearer' | 'oauth', ReadonlySet<string>>> = {
      none: new Set(['type']),
      bearer: new Set(['type', 'token', 'tokenEnv']),
      oauth: new Set([
        'type',
        'accessToken',
        'tokenEnv',
        'resource',
        'authorizationServer',
        'clientId',
        'scopes',
      ]),
    };
    for (const key of Object.keys(auth)) {
      if (!allowed[type].has(key)) {
        return `${where}.${key} 不适用于 ${type} 认证（拒绝跨类型/未知键，避免静默忽略）`;
      }
    }
    for (const key of [
      'token',
      'tokenEnv',
      'accessToken',
      'resource',
      'authorizationServer',
      'clientId',
    ]) {
      if (auth[key] !== undefined && typeof auth[key] !== 'string') {
        return `${where}.${key} 必须是字符串`;
      }
    }
    if (auth['scopes'] !== undefined) {
      if (
        !Array.isArray(auth['scopes']) ||
        auth['scopes'].some((scope) => typeof scope !== 'string')
      ) {
        return `${where}.scopes 必须是字符串数组`;
      }
    }
    return undefined;
  }
}
