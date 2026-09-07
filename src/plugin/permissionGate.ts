import { ALL_PERMISSIONS } from './permission.js';
import type { PluginPermission } from './permission.js';

/**
 * @beta
 * 权限校验结果。
 */
export interface PermissionDecision {
  readonly allowed: boolean;
  /** 未被白名单放行的权限（为空即完全允许）。 */
  readonly missing: readonly PluginPermission[];
}

import { OmniError, ErrorCode } from '../errors.js';

/**
 * @beta
 * 权限校验失败（fail-closed）。
 */
export class PermissionDeniedError extends OmniError {
  constructor(
    readonly pluginName: string,
    readonly missing: readonly PluginPermission[],
  ) {
    super(
      ErrorCode.PERMISSION_DENIED,
      `插件 "${pluginName}" 权限未在白名单内，已拒绝: ${missing.join(', ')}`,
    );
  }
}

/**
 * @beta
 * 插件权限门禁：依白名单校验插件声明的权限，未放行的能力一律拒绝（fail-closed）。
 * - 插件未声明权限 → 允许（无能力声明，不含任何敏感权限）
 * - 声明的权限 ⊆ 白名单 → 允许
 * - 含超白名单权限 → 拒绝并返回缺失清单
 */
export class PermissionGate {
  private readonly allowed: ReadonlySet<PluginPermission>;

  private constructor(allowed: ReadonlySet<PluginPermission>) {
    this.allowed = allowed;
  }

  /** 全部拒绝（严格默认）。 */
  static denyAll(): PermissionGate {
    return new PermissionGate(new Set());
  }

  /** 全部放行（仅测试 / 完全信任）。 */
  static allowAll(): PermissionGate {
    return new PermissionGate(new Set(ALL_PERMISSIONS));
  }

  /** 从权限列表构造白名单。 */
  static fromList(permissions: readonly PluginPermission[]): PermissionGate {
    return new PermissionGate(new Set(permissions));
  }

  /** 校验一组权限；返回是否放行及缺失清单。 */
  check(permissions: readonly PluginPermission[] | undefined): PermissionDecision {
    const missing: PluginPermission[] = [];
    for (const permission of permissions ?? []) {
      if (!this.allowed.has(permission)) {
        missing.push(permission);
      }
    }
    return { allowed: missing.length === 0, missing };
  }

  /** 校验并抛错（供管理器 register 阶段调用）。 */
  assertAllowed(pluginName: string, permissions: readonly PluginPermission[] | undefined): void {
    const decision = this.check(permissions);
    if (!decision.allowed) {
      throw new PermissionDeniedError(pluginName, decision.missing);
    }
  }
}
