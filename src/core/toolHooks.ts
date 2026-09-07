import type { ToolResult } from '../ports/tool.js';

/** 钩子上下文。 */
export interface ToolHookContext {
  readonly sessionId: string;
  readonly toolName: string;
  readonly target: string;
  /** 工具入参（#M5）：需要读 path/content 的钩子（如变更追踪）依赖它，纯观测钩子可忽略。调用点均会传入，类型标可选仅为兼容旧调用。 */
  readonly args?: Record<string, unknown>;
}

/** 单组钩子（pre / post）。 */
export interface ToolHooks {
  readonly pre?: (context: ToolHookContext) => Promise<void> | void;
  readonly post?: (context: ToolHookContext, result: ToolResult) => Promise<void> | void;
}

/** 工具钩子运行器：pre 依序、post 逆序（策略插件可拦截/改写/记录，权限即插件）。 */
export class ToolHookRunner {
  private readonly hooks: ToolHooks[] = [];

  /** 注册钩子组。 */
  add(hooks: ToolHooks): void {
    this.hooks.push(hooks);
  }

  /** 执行前钩子（依序）。 */
  async pre(context: ToolHookContext): Promise<void> {
    for (const hooks of this.hooks) {
      if (hooks.pre !== undefined) {
        await hooks.pre(context);
      }
    }
  }

  /** 执行后钩子（逆序，保证对称清理）。 */
  async post(context: ToolHookContext, result: ToolResult): Promise<void> {
    for (const hooks of [...this.hooks].reverse()) {
      if (hooks.post !== undefined) {
        await hooks.post(context, result);
      }
    }
  }
}
