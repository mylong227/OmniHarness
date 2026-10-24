/**
 * @beta
 * run_workflow 工具名（多步 DAG 编排 编排）。
 *
 * 值来自 `ports/tool/toolNames.ts`（工具名单一来源）：导出名不变，名字只声明一次。
 */
import { TOOL_NAMES } from '../ports/tool/toolNames.ts';

/**
 * @beta
 */
export const RUN_WORKFLOW_TOOL_NAME = TOOL_NAMES.runWorkflow;
