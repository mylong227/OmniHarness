// class 组件基类：桥接「应用上下文」与「面向对象组件」。
//
// 背景：React hooks 只能在函数组件中使用，class 组件拿不到 useApp()。
// 本基类通过 static contextType 把 AppContext 挂到 this.context，
// 并暴露受保护的 api / toast 访问器，让 class 组件与函数组件享受同一套服务注入。
//
// 设计约束（与 useApp 保持一致）：不在 Provider 内使用时 fail-closed 抛错，绝不静默降级。

import { React } from '../deps.js';
import { AppContext } from '../context.js';
import type { AppContextValue } from '../context.js';
import type { ApiClient } from '../../core/ApiClient.js';
import type { ToastKind } from '../../core/ToastService.js';

/** 无 props 组件的默认 props 类型：显式空对象，避免 any。 */
export type EmptyProps = Record<string, never>;

/**
 * UI 组件基类。泛型 P = props，S = state。
 * 子类通过 `this.api` 调后端、通过 `this.toast` 提示用户，无需逐层透传。
 */
export abstract class AppComponent<
  P = EmptyProps,
  S = Record<string, unknown>,
> extends React.Component<P, S> {
  /** React 在挂载时把最近的 Provider 值写入 this.context。 */
  static contextType = AppContext;

  /** 类型为「值或 null」：Provider 缺失时必须显式失败，而不是假装非空。 */
  declare context: AppContextValue | null;

  /** 应用上下文（已校验非 null）。 */
  protected get app(): AppContextValue {
    const ctx = this.context;
    if (!ctx) throw new Error('AppComponent 必须在 AppContext.Provider 内使用');
    return ctx;
  }

  /** 后端 RPC 客户端。 */
  protected get api(): ApiClient {
    return this.app.api;
  }

  /** 弹出提示（成功/错误等）。 */
  protected toast(message: string, kind?: ToastKind): void {
    this.app.toast(message, kind);
  }

  /** 请求刷新模型目录（由 App 注入，可能未注入）。 */
  protected refreshModelCatalog(): void {
    this.app.refreshModelCatalog?.();
  }
}
