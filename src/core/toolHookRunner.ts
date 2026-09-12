import type { ToolResult } from '../ports/tool.js';
import type { ToolHookContext, ToolHooks } from '../ports/toolHook.js';

/** 工具钩子运行器：pre 依序、post 逆序（策略插件可拦截/改写/记录，权限即插件）。 */
export class ToolHookRunner {
  private readonly hooks: ToolHooks[] = [];

  /** 注册钩子组。 */
  public add(hooks: ToolHooks): void {
    this.hooks.push(hooks);
  }

  /** 执行前钩子（依序）。 */
  public async pre(context: ToolHookContext): Promise<void> {
    for (const hooks of this.hooks) {
      if (hooks.pre !== undefined) {
        await hooks.pre(context);
      }
    }
  }

  /** 执行后钩子（逆序，保证对称清理）。 */
  public async post(context: ToolHookContext, result: ToolResult): Promise<void> {
    for (const hooks of [...this.hooks].reverse()) {
      if (hooks.post !== undefined) {
        await hooks.post(context, result);
      }
    }
  }
}
