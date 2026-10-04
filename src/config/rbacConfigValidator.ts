/**
 * `rbac` 配置段的严格校验（F3）。
 *
 * 沿 `permissionConfigValidator` / `capabilityConfigValidator` 的既定范式：**只拦"写错了"**
 * （未知子键 / 类型不符），不替运维做策略判断（角色名是否存在由策略层 fail-closed 兜底）。
 *
 * 为什么这一段要严格：**写错角色名或把 `mutating` 写成字符串，会让人以为"权限已收紧"**——
 * 安全档位上的静默忽略代价最高（同 `capability` 段的理由）。
 *
 * @maturity L1 — 未知子键/类型不符/角色表结构三类拒绝 判据钉死
 * @maturityEvidence tests/unit/rbacConfig.test.ts
 */

/** `rbac` 段允许的子键。 */
const RBAC_KEYS: ReadonlySet<string> = new Set(['enabled', 'role', 'roles']);

/** 角色条目允许的子键。 */
const ROLE_KEYS: ReadonlySet<string> = new Set(['allow', 'deny', 'mutating']);

/** RBAC 配置校验器。 */
export class RbacConfigValidator {
  private constructor() {}

  /**
   * 校验 `rbac` 段。
   * @param cfg 文件配置（读其 `rbac` 字段）
   * @returns 错误消息；合法时为 undefined
   */
  public static validate(cfg: unknown): string | undefined {
    const raw = (cfg as { readonly rbac?: unknown } | null)?.rbac;
    if (raw === undefined) return undefined;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return 'rbac 段必须是对象';
    }
    const record = raw as Record<string, unknown>;
    const unknown = RbacConfigValidator.firstUnknownKey(record, RBAC_KEYS);
    if (unknown !== undefined) return `rbac 段含未知配置项 "${unknown}"`;
    if (record['enabled'] !== undefined && typeof record['enabled'] !== 'boolean') {
      return 'rbac.enabled 必须是布尔值';
    }
    if (record['role'] !== undefined) {
      if (typeof record['role'] !== 'string' || record['role'].trim() === '') {
        return 'rbac.role 必须是非空字符串（角色名）';
      }
    }
    // fail-closed 的关键一条：开了门禁却没给角色 ⇒ 直接拒绝配置。
    // 若放行，运行时只能二选一：要么全拒（工具全废）要么全放（门禁形同虚设）——两个都不可接受。
    if (record['enabled'] === true && record['role'] === undefined) {
      return 'rbac.enabled 为 true 时必须给出 rbac.role（否则只能全拒或全放，两者都不可接受）';
    }
    if (record['roles'] === undefined) return undefined;
    const roles = record['roles'];
    if (typeof roles !== 'object' || roles === null || Array.isArray(roles)) {
      return 'rbac.roles 必须是「角色名 → 规格」对象';
    }
    for (const [name, spec] of Object.entries(roles as Record<string, unknown>)) {
      if (name.trim() === '') return 'rbac.roles 含空角色名';
      const verdict = RbacConfigValidator.validateRole(name, spec);
      if (verdict !== undefined) return verdict;
    }
    return undefined;
  }

  /**
   * 校验单个角色条目。
   * @param name 角色名
   * @param spec 规格
   * @returns 错误消息；合法时为 undefined
   */
  private static validateRole(name: string, spec: unknown): string | undefined {
    if (typeof spec !== 'object' || spec === null || Array.isArray(spec)) {
      return `rbac.roles.${name} 必须是对象`;
    }
    const record = spec as Record<string, unknown>;
    const unknown = RbacConfigValidator.firstUnknownKey(record, ROLE_KEYS);
    if (unknown !== undefined) return `rbac.roles.${name} 含未知配置项 "${unknown}"`;
    const allow = record['allow'];
    if (!Array.isArray(allow) || allow.some((v) => typeof v !== 'string')) {
      return `rbac.roles.${name}.allow 必须是字符串数组（可为空数组）`;
    }
    const deny = record['deny'];
    if (deny !== undefined && (!Array.isArray(deny) || deny.some((v) => typeof v !== 'string'))) {
      return `rbac.roles.${name}.deny 必须是字符串数组`;
    }
    if (record['mutating'] !== undefined && typeof record['mutating'] !== 'boolean') {
      return `rbac.roles.${name}.mutating 必须是布尔值`;
    }
    return undefined;
  }

  /**
   * 取第一个未知子键。
   * @param obj 待检查对象
   * @param allowed 允许的键集合
   * @returns 未知键名；全部合法时为 undefined
   */
  private static firstUnknownKey(
    obj: Readonly<Record<string, unknown>>,
    allowed: ReadonlySet<string>,
  ): string | undefined {
    return Object.keys(obj).find((key) => !allowed.has(key));
  }
}
