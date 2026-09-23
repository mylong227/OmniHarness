/**
 * @beta
 * run_goal 工具名（自主目标循环，对标 dsh goal/ralph）。
 *
 * 值来自 `ports/tool/toolNames.ts`（工具名单一来源）：导出名不变，名字只声明一次。
 */
import { TOOL_NAMES } from '../ports/tool/toolNames.js';

/**
 * @beta
 */
export const RUN_GOAL_TOOL_NAME = TOOL_NAMES.runGoal;
