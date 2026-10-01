import type { ToolHookContext } from './toolHookContext.js';
import type { ToolResult } from '../tool.js';

/**
 * 工具钩子端口（P1 解耦）。
 *
 * 原 `ToolHookContext` / `ToolHooks` 定义在 `core/toolHookRunner.ts`，被适配器
 * `adapters/diff/turnDiffHooks` 以 `import type` 引用，构成 adapters→core 违规（门禁按
 * 导入路径计边）。抽到端口后，适配器与 core 的钩子运行器共用同一组接口类型，零运行时耦合。
 */
/** 单组钩子（pre / post）。 */
export interface ToolHooks {
  readonly pre?: (context: ToolHookContext) => Promise<void> | void;
  readonly post?: (context: ToolHookContext, result: ToolResult) => Promise<void> | void;
}
