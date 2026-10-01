import type { ToolResult } from './tool.js';
import type { ToolHookContext, ToolHooks } from './toolHook.js';

/**
 * @beta
 * 工具钩子运行器端口：pre 依序、post 逆序（策略插件可拦截/改写/记录，权限即插件）。
 * 由 `core/toolHookRunner.ts` 的 `ToolHookRunner` 实现；`ResolvedConfig` / `OmniHarnessRuntime`
 * 等仅依赖本端口契约，不再反向依赖 core 层，解除 `ports→core` 的 `[3.5]` 禁边。
 */
export interface ToolHookRunnerPort {
  /**
   * 注册钩子组。
   * @param hooks 一组 pre/post 工具钩子（策略插件实现）。
   * @returns 无返回值。
   */
  add(hooks: ToolHooks): void;

  /**
   * 执行前钩子（依序）。
   * @param context 钩子上下文（会话、工具名、目标、入参）。
   * @returns 无返回值。
   */
  pre(context: ToolHookContext): Promise<void>;

  /**
   * 执行后钩子（逆序，保证对称清理）。
   * @param context 钩子上下文（与 pre 收到的同一上下文）。
   * @param result 工具执行结果（post 可观测/善后，不改变已记录结果）。
   * @returns 无返回值。
   */
  post(context: ToolHookContext, result: ToolResult): Promise<void>;
}
