import type { PermissionRuleDecision } from './permissionRuleDecision.js';

/**
 * 单条权限规则（配置文件形态）：工具级 + 命令级（前缀或 glob）约束。
 *
 * 与适配层的 `ApprovalRule` 结构等价但**分层独立**——配置层不依赖适配层（六边形依赖方向）。
 * 装配时由 CLI 构建层映射为 `ApprovalRule`。
 *
 * 已从 `config/configFile.ts` 外迁到 ports/config：原文件退化为纯再导出桶，调用点零改动。
 */
export interface PermissionRuleConfig {
  /** 限定工具名（未声明则不限制工具）。 */
  readonly toolName?: string;
  /** 命令前缀约束（`startsWith` 匹配）。 */
  readonly commandPrefix?: string;
  /** 命令 glob 约束（`*` 任意串 / `?` 单字符，整串匹配）。 */
  readonly commandGlob?: string;
  /** 命中后的裁决。 */
  readonly decision: PermissionRuleDecision;
}
