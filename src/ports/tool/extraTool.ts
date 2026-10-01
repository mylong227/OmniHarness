import type { ToolDefinition } from './tool/toolDefinition.js';
import type { ToolHandler } from './toolHandler.js';

/** 额外自定义工具（定制接入专用插口）。 */
export interface ExtraTool {
  /** 工具定义（名称、描述、参数 schema）。 */
  readonly definition: ToolDefinition;
  /** 工具处理函数（执行逻辑）。 */
  readonly handler: ToolHandler;
}
