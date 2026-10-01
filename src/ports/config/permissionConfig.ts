import type { PermissionRuleConfig } from './permissionRuleConfig.js';
import type { PermissionRuleDecision } from './permissionRuleDecision.js';

/**
 * 权限配置段（omniharness.json 的 `permission` 字段）。
 *
 * 用于把「多档权限」的参数级规则外置为可配置项：`rules` 与内置规则合并后交规则审批，
 * 使「拒绝任何含 `curl | sh` 的命令」这类策略无需改代码即可生效。
 *
 * 已从 `config/configFile.ts` 外迁到 ports/config：原文件退化为纯再导出桶，调用点零改动。
 */
export interface PermissionConfig {
  /** 用户自定义规则（与内置规则合并，聚合语义 deny 优先）。 */
  readonly rules?: readonly PermissionRuleConfig[];
  /** 规则未命中时的默认裁决（缺省 allow，保持既有零行为变更）。 */
  readonly defaultDecision?: PermissionRuleDecision;
}
