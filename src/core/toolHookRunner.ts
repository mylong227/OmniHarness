import type { ToolResult } from '../ports/tool.js';
import type { ToolHookContext, ToolHooks } from '../ports/toolHook.js';

/** 工具钩子运行器：pre 依序、post 逆序（策略插件可拦截/改写/记录，权限即插件）。 */
export class ToolHookRunner {
  /** 已注册的钩子组（注册序即 pre 执行序；post 逆序保证对称清理）。 */
  private readonly hooks: ToolHooks[] = [];

  /**
   * 注册钩子组。
   * @param hooks 一组 pre/post 工具钩子（策略插件实现）。
   
 * @returns 无返回值。
*/
  public add(hooks: ToolHooks): void {
    this.hooks.push(hooks);
  }

  /**
   * 执行前钩子（依序）。
   * @param context 钩子上下文（会话、工具名、目标、入参）。
   
 * @returns 无返回值。
*/
  public async pre(context: ToolHookContext): Promise<void> {
    for (const hooks of this.hooks) {
      if (hooks.pre !== undefined) {
        await hooks.pre(context);
      }
    }
  }

  /**
   * 执行后钩子（逆序，保证对称清理）。
   * @param context 钩子上下文（与 pre 收到的同一上下文）。
   * @param result 工具执行结果（post 可观测/善后，不改变已记录结果）。
   
 * @returns 无返回值。
*/
  public async post(context: ToolHookContext, result: ToolResult): Promise<void> {
    for (const hooks of [...this.hooks].reverse()) {
      if (hooks.post !== undefined) {
        await hooks.post(context, result);
      }
    }
  }
}
