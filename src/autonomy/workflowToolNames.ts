/**
 * @beta
 * run_workflow 工具名（agent-team / workflow DAG 编排）。
 *
 * 值来自 `ports/tool/toolNames.ts`（工具名单一来源）：导出名不变，名字只声明一次。
 */
import { TOOL_NAMES } from '../ports/tool/toolNames.js';

/**
 * @beta
 */
export const RUN_WORKFLOW_TOOL_NAME = TOOL_NAMES.runWorkflow;
