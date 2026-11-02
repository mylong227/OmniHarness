/**
 * RBAC 配置段（F3 · 商业化路线图阶段 1「企业包初版 RBAC-lite」）。
 *
 * 形状与用法：
 * ```jsonc
 * {
 *   "rbac": {
 *     "enabled": true,
 *     "role": "editor",
 *     // 可选：整体替换内建角色表（不做半覆盖——半覆盖会产生难以推理的混合语义）
 *     "roles": { "auditor": { "allow": ["*"], "deny": ["write_file", "mcp__*"], "mutating": false } }
 *   }
 * }
 * ```
 *
 * **为什么 `role` 单独一个字段而不是塞进 roles**：`roles` 是**角色定义**（策略），`role` 是**本次会话的身份**
 * （运行时状态）。混在一起会让"换个角色试一下"变成改策略表。
 */

/** 单个角色的工具授权规格。 */
export interface RbacRoleConfig {
  /** 允许的工具模式（精确名或尾部 `*` 通配；`['*']` = 全部）。 */
  readonly allow: readonly string[];
  /** 拒绝的工具模式（优先级高于 `allow`）。 */
  readonly deny?: readonly string[] | undefined;
  /** 是否允许写类工具（`false` ⇒ 写类一律拒，即使 `allow` 命中）。 */
  readonly mutating?: boolean | undefined;
}

/** RBAC 配置段。 */
export interface RbacConfig {
  /** 是否启用角色门禁（缺省/非 true = 不启用，**零行为变更**）。 */
  readonly enabled?: boolean | undefined;
  /** 本次会话的角色名（未启用时忽略；启用而缺省 ⇒ 组合根按 fail-closed 处理）。 */
  readonly role?: string | undefined;
  /** 角色表（给出即**整体替换**内建三角色）。 */
  readonly roles?: Readonly<Record<string, RbacRoleConfig>> | undefined;
}
