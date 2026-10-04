/**
 * 角色策略端口（商业化路线图 **F3** RBAC-lite 的契约层）。
 *
 * ## 它回答什么
 *
 * 「**这个角色**能不能调**这个工具**」——与审批（要不要人点确认）/ 沙箱（OS 层能力）正交的**第三道门**：
 * 角色决定**可见能力边界**，审批决定**单次是否放行**，沙箱决定**执行时被允许做什么**。
 * 三者叠加才构成完整门禁（`ToolGate` 按 supervisor → 角色 → 计划 → 审批 → 沙箱 的顺序裁决）。
 *
 * ## 失败语义（fail-closed，`core`/`ports` 不许抛）
 *
 * - **未知角色** ⇒ 一律拒（不是"退回默认角色"——那会让配置打错字变成静默提权）；
 * - **未登记工具**（不在工具清单内）⇒ 一律拒（"这工具是不是写类"无从判断时，默认不许）；
 * - **拒必须带可读原因**：点名角色、工具、以及**缺什么**（沿 G5 判据风格：拒绝条件要能直接进 UI/日志归因）。
 */

import type { ToolCall } from '../tool/tool.js';

/** 角色名（实现侧给默认表；字符串便于配置注入自定义角色）。 */
export type RoleName = string;

/** 单次裁决结论。 */
export type RoleDecision =
  | { readonly allow: true }
  | {
      /** 拒绝。 */
      readonly allow: false;
      /** 可读原因（点名角色 / 工具 / 缺什么）。 */
      readonly reason: string;
    };

/** 角色策略端口。 */
export interface RolePolicyPort {
  /**
   * 裁决某角色能否调用某工具。
   * @param role 角色名（来自配置；未知即拒）
   * @param call 待裁决的工具调用
   * @returns 放行或带原因的拒绝
   */
  decide(role: RoleName, call: ToolCall): RoleDecision;
  /**
   * 当前生效角色的能力摘要（供 CLI / 治理台展示"这个角色能干什么"）。
   * @param role 角色名
   * @returns 允许与拒绝的模式列表；未知角色为空
   */
  describe(role: RoleName): { readonly allow: readonly string[]; readonly deny: readonly string[] };
}
