import type { ModelRouterEntryConfig } from './modelRouterEntryConfig.js';

/**
 * 模型路由配置（#B4）。
 *
 * 已从 `config/configFile.ts` 外迁到 ports/config：原文件退化为纯再导出桶，调用点零改动。
 */
export interface ModelRouterConfig {
  readonly strategy: string;
  readonly entries: readonly ModelRouterEntryConfig[];
  /** by-task 策略下仅匹配该 role 的消息（可选）。 */
  readonly taskField?: string;
}
