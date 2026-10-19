// 视图布局 / 主题偏好控制器（从 AppController 抽离，避免越过 25 方法的上帝类红线）。
// 单一职责：主题切换、左右面板开合、面板宽度持久化、首屏偏好恢复。全部经 AppHost.patch 驱动状态。

import type { AppHost } from './AppController.ts';
import { MethodBinder } from './methodBinder.ts';
import { setLocale as applyLocale, t, type Locale } from '../i18n/i18n.ts';
import {
  applyTheme,
  readThemePreference,
  resolveTheme,
  watchSystemTheme,
  type ThemePreference,
} from '../models/ThemePreference.ts';

/** 布局 / 主题偏好控制器。 */
export class LayoutController {
  /** 状态宿主（App 组件）。 */
  private readonly host: AppHost;

  /** 系统主题订阅的取消函数（偏好不是 `system` 时为 null）。 */
  private unwatchSystem: (() => void) | null = null;

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
   * 从 localStorage 恢复主题偏好 / 模型清单 / 面板宽度（挂载时调用一次）。
   *
   * 主题默认**跟随系统**（2026-10-18）：从未选择过的用户按 `prefers-color-scheme` 取首屏，
   * 且不把"猜出来的结果"当成用户选择写回。首帧前的取值由 `index.html` 的内联脚本完成，
   * 这里负责把同一结果同步进 React 状态、并挂上系统主题的订阅。
   * @returns 无
   */
  public initTheme(): void {
    const pref = readThemePreference();
    const theme = applyTheme(pref);
    if (pref === 'system') this.watchSystem();
    this.host.patch({ theme, themePref: pref });
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
   * 设置主题偏好（系统 / 深色 / 浅色三态，持久化并立即生效）。
   *
   * 偏好为 `system` 时挂上系统主题订阅：系统在日落切换到暗色时界面跟着走；
   * 一旦用户显式选了明/暗，就取消订阅（锁定选择，不再被系统覆盖）。
   * @param pref 目标偏好
   * @returns 无
   */
  public setThemePref(pref: ThemePreference): void {
    const theme = applyTheme(pref);
    if (pref === 'system') {
      this.watchSystem();
    } else if (this.unwatchSystem !== null) {
      this.unwatchSystem();
      this.unwatchSystem = null;
    }
    this.host.patch({ theme, themePref: pref });
  }

  /**
   * 页脚/中栏按钮的「明暗互换」：始终写成显式偏好（这本身就是一次用户选择）。
   * @returns 无
   */
  public toggleTheme(): void {
    this.setThemePref(this.host.getState().theme === 'light' ? 'dark' : 'light');
  }

  /**
   * 挂上系统主题订阅（幂等：已在订阅中则什么都不做）。
   * @returns 无
   */
  private watchSystem(): void {
    if (this.unwatchSystem !== null) return;
    this.unwatchSystem = watchSystemTheme(() => {
      if (this.host.getState().themePref !== 'system') return;
      const theme = resolveTheme('system');
      document.documentElement.setAttribute('data-theme', theme);
      this.host.patch({ theme });
    });
  }

  /**
   * 切换界面语言（中文 / English）：i18n 模块态 + localStorage（模块内）+ App 状态（触发全树
   * 重渲染）三处同步；t() 在渲染期读模块态，故重渲染后文案即刻换语言。
   *
   * 只负责"即时生效"；把 locale **持久化到服务端配置**是 SettingsController.setLocale 的
   * 职责（那是配置写盘，不是布局状态）。
   * @param l 目标语言
   * @returns 无
   */
  public setLocale(l: Locale): void {
    applyLocale(l);
    // 标签页标题同步换语言（挂载首设见 AppController.mount → settings.applyConfigLocale）。
    document.title = t('OmniHarness 工作台');
    this.host.patch({ locale: l });
  }

  /** 切换左侧会话面板（互斥关闭右侧）。 @returns 无 */
  public toggleLeft(): void {
    this.host.patch((s) => ({ leftOpen: !s.leftOpen, rightOpen: false }));
  }

  /** 打开功能面板模态（右栏「全部面板」按钮 / 命令面板入口）。 @returns 无 */
  public openPanels(): void {
    this.host.patch({ panelModalOpen: true });
  }

  /** 关闭功能面板模态。 @returns 无 */
  public closePanels(): void {
    this.host.patch({ panelModalOpen: false });
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
