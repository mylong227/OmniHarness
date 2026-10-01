/**
 * 权限规则裁决（配置文件形态）。
 *
 * 已从 `config/configFile.ts` 外迁到 ports/config：原文件退化为纯再导出桶，调用点零改动。
 */
export type PermissionRuleDecision = 'allow' | 'deny' | 'ask';
