/**
 * @beta
 * run_goal 工具名（自主目标循环，借鉴同类成熟实现 goal/ralph）。
 *
 * 值来自 `ports/tool/toolNames.ts`（工具名单一来源）：导出名不变，名字只声明一次。
 */
import { TOOL_NAMES } from '../ports/tool/toolNames.ts';

/**
 * @beta
 */
export const RUN_GOAL_TOOL_NAME = TOOL_NAMES.runGoal;
