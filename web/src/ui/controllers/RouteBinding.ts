// 前端路由绑定（F8）：持有当前路由状态、把局部补丁写入 hash、订阅浏览器前进 / 后退并收口到 App 状态。
// 从 AppController 抽离，避免根控制器越过 25 方法的上帝类红线；AppController 仅持有本类并委托。

import { parseHash, navigate, onRouteChange, type AppRoute } from '../../core/Router.js';
import type { AppHost, AppState } from './AppController.js';

/** 路由收口回调（把解析后的路由落到应用状态）。 */
export type RouteApply = (route: AppRoute) => void;

/**
 * 哈希路由绑定：单一职责——哈希 ↔ 应用状态 的双向同步。
 * 深链（刷新 / 分享）由初始 hash 恢复；浏览器前进 / 后退由 hashchange 驱动。
 */
export class RouteBinding {
  /** 当前路由（hash 单一事实源）。 */
  private route: AppRoute;
  /** hashchange 订阅取消句柄。 */
  private off: (() => void) | null = null;
  /** 状态宿主（App 组件）。 */
  private readonly host: AppHost;
  /** 打开会话回调（深链 / 前进后退到达会话时加载）。 */
  private readonly onThread: (id: string) => void;

  /**
   * 构造并解析初始路由。
   * @param host 状态宿主
   * @param onThread 打开会话回调
   */
  public constructor(host: AppHost, onThread: (id: string) => void) {
    this.host = host;
    this.onThread = onThread;
    this.route = parseHash();
  }

  /** 当前路由。 @returns 路由 */
  public current(): AppRoute {
    return this.route;
  }

  /**
   * 合并局部补丁写入 hash（触发 hashchange → apply 收口）。相同 hash 不触发事件，幂等。
   * @param partial 路由局部补丁；省略字段沿用当前路由，threadId 传 null 表示清空。
   * @returns 无
   */
  public navigate(partial: Partial<AppRoute>): void {
    const pane = partial.pane ?? this.route.pane;
    const threadId = partial.threadId !== undefined ? partial.threadId : this.route.threadId;
    this.route = { pane, threadId };
    navigate(this.route);
  }

  /** 启动：应用初始深链状态 + 订阅浏览器前进 / 后退。 @returns 无 */
  public start(): void {
    this.apply(this.route);
    this.off = onRouteChange((r) => this.apply(r));
  }

  /** 停止：移除订阅。 @returns 无 */
  public stop(): void {
    if (this.off !== null) this.off();
  }

  /**
   * 把路由落到应用状态：设置激活面板（非 tools 时展开右栏），必要时加载会话。
   * @param r 解析后的路由
   * @returns 无
   */
  private apply(r: AppRoute): void {
    this.route = r;
    const patch: Partial<AppState> = { activePane: r.pane };
    // 深链 / 前进后退到达具体面板时展开右栏，便于直接看到目标 tab。
    if (r.pane !== 'tools') patch.rightOpen = true;
    this.host.patch(patch);
    const cur = this.host.getState().currentThreadId;
    if (r.threadId !== null && r.threadId !== cur) this.onThread(r.threadId);
  }
}
