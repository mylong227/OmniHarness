// 视图布局 / 主题偏好控制器（从 AppController 抽离，避免越过 25 方法的上帝类红线）。
// 单一职责：主题切换、左右面板开合、面板宽度持久化、首屏偏好恢复。全部经 AppHost.patch 驱动状态。

import type { AppHost } from './AppController.js';
import { MethodBinder } from './methodBinder.js';

/** 布局 / 主题偏好控制器。 */
export class LayoutController {
  /** 状态宿主（App 组件）。 */
  private readonly host: AppHost;

  /**
   * 构造。
   * @param host 状态宿主
   */
  public constructor(host: AppHost) {
    this.host = host;
    // 本类的方法**全部**以裸引用传给子组件（onToggleTheme / onToggleLeft / onToggleRight /
    // onLeftWidthChange / onRightWidthChange）⇒ 必须绑定，否则每次点击都在事件处理器里抛
    // `this.host` 读取失败（表现为「按钮点了没反应」）。见 MethodBinder。
    MethodBinder.bindAll(this);
  }

  /**
   * 从 localStorage 恢复主题 / 模型清单 / 面板宽度（挂载时调用一次）。
   * @returns 无
   */
  public initTheme(): void {
    let theme: 'dark' | 'light' = 'dark';
    try {
      theme = (localStorage.getItem('omni-theme') || 'dark') === 'light' ? 'light' : 'dark';
    } catch {
      /* 忽略 */
    }
    document.documentElement.setAttribute('data-theme', theme);
    try {
      localStorage.setItem('omni-theme', theme);
    } catch {
      /* 忽略 */
    }
    this.host.patch({ theme });
    try {
      const cachedOptions = localStorage.getItem('omni-model-options');
      const cachedLabel = localStorage.getItem('omni-provider-label');
      if (cachedOptions) {
        const parsed = JSON.parse(cachedOptions) as string[];
        if (Array.isArray(parsed) && parsed.length > 0) this.host.patch({ modelOptions: parsed });
      }
      if (cachedLabel) this.host.patch({ providerLabel: cachedLabel });
      const cachedLeft = Number(localStorage.getItem('omni-left-width'));
      const cachedRight = Number(localStorage.getItem('omni-right-width'));
      if (cachedLeft >= 180 && cachedLeft <= 600) this.host.patch({ leftWidth: cachedLeft });
      if (cachedRight >= 180 && cachedRight <= 760) this.host.patch({ rightWidth: cachedRight });
      // 右栏收起态也是本机偏好：上次收着，这次就别再撑开（2026-10-07 用户反馈「右栏也要可收起」）。
      this.host.patch({ rightCollapsed: localStorage.getItem('omni-right-collapsed') === '1' });
    } catch {
      /* 忽略 */
    }
  }

  /**
   * 切换浅色 / 深色主题（同步写 document 属性与 localStorage）。
   * @returns 无
   */
  public toggleTheme(): void {
    const next: 'dark' | 'light' = this.host.getState().theme === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', next);
    try {
      localStorage.setItem('omni-theme', next);
    } catch {
      /* 忽略 */
    }
    this.host.patch({ theme: next });
  }

  /** 切换左侧会话面板（互斥关闭右侧）。 @returns 无 */
  public toggleLeft(): void {
    this.host.patch((s) => ({ leftOpen: !s.leftOpen, rightOpen: false }));
  }

  /**
   * 切换右侧面板：桌面端 = 收起 / 展开整栏（持久化本机偏好）；窄屏（≤880px）= 抽屉（互斥关闭左栏）。
   * 2026-10-07 用户反馈「右侧栏也要可以收起来」前的行为只有抽屉一态，桌面端 12 面板常驻占宽。
   * @returns 无
   */
  public toggleRight(): void {
    if (window.innerWidth <= 880) {
      this.host.patch((s) => ({ rightOpen: !s.rightOpen, leftOpen: false }));
      return;
    }
    const next = !this.host.getState().rightCollapsed;
    try {
      localStorage.setItem('omni-right-collapsed', next ? '1' : '');
    } catch {
      /* 忽略 */
    }
    this.host.patch({ rightCollapsed: next });
  }

  /**
   * 左/右侧面板拖拽宽度变更（持久化到 localStorage）。
   * @param w 宽度
   * @returns 无
   */
  public onLeftWidthChange(w: number): void {
    this.host.patch({ leftWidth: w });
    try {
      localStorage.setItem('omni-left-width', String(w));
    } catch {
      /* 忽略 */
    }
  }

  /**
   * 右/左侧面板拖拽宽度变更（持久化到 localStorage）。
   * @param w 宽度
   * @returns 无
   */
  public onRightWidthChange(w: number): void {
    this.host.patch({ rightWidth: w });
    try {
      localStorage.setItem('omni-right-width', String(w));
    } catch {
      /* 忽略 */
    }
  }
}
