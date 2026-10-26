// 设置与界面语言子控制器。
//
// ## 为什么单开一个（而不是继续留在 AppController）
//
// 仓库的 `CODE_STANDARD` 有「上帝类」判据：一个类**成员（方法 + 属性）> 25** 即违规，
// 且该判据参与增量门禁（新越线即红）。`AppController` 在 HEAD 时恰好 25 个成员——**顶在线上**，
// 再往里加任何一个都会越线。2026-10-17 加设置模态时一次加了 5 个（open/close/tab/permission/locale）
// ⇒ 29，门禁直接报红。
//
// 正确的应对不是合并方法名去凑数（那只是把复杂度藏进参数），而是**把这些成员归到它们真正的主语**：
// 设置模态的开合、分栏定位，以及"界面语言"这一项跨端偏好，本来就与
// 「连接 SSE / 路由 / 审批」这些 AppController 自身职责无关。搬到这里后：
//   · AppController 回到 25 成员以下（门禁复原）；
//   · 设置域的语义集中在一处，settingsOpen / settingsTab / locale 三个状态字段的读写不再散落。
//
// 与既有子控制器（sessions / composer / graph / files / layout）同级，由 AppController 组合根装配。

import type { Locale } from '../i18n/i18n.ts';
import type { SettingsTabKey } from '../models/SettingsModel.ts';
import type { ApiClient } from '../../core/ApiClient.ts';
import { MethodBinder } from './methodBinder.ts';
// `AppHost` 定义在 AppController 里。这里用 `import type`——它会被**完全擦除**，
// 因此不构成 AppController ⇄ SettingsController 的运行时循环（既有 ComposerController /
// FileController 同款做法）。
import type { AppHost } from './AppController.ts';
import type { LayoutController } from './LayoutController.ts';

/** SettingsController 的依赖。 */
export interface SettingsControllerDeps {
  /** 布局控制器：界面语言的模块态 / localStorage / 重渲染由它承接（即时生效）。 */
  readonly layout: LayoutController;
  /** 服务端客户端：语言与其它设置一样落盘到用户级 omniharness.json。 */
  readonly api: ApiClient;
}

/**
 * 设置子控制器：控制台设置页的开合与分栏、界面语言切换（含落盘）。
 */
export class SettingsController {
  /** 状态宿主（`patch` 提交 App 状态：settingsOpen / settingsTab 都经它落地）。 */
  private readonly host: AppHost;

  /** 依赖（布局控制器管语言即时生效；服务端客户端管落盘）。构造后不变。 */
  private readonly deps: SettingsControllerDeps;

  /**
   * @param host 状态宿主（patch 提交 App 状态）
   * @param deps 布局控制器与服务端客户端
   */
  public constructor(host: AppHost, deps: SettingsControllerDeps) {
    this.host = host;
    this.deps = deps;
    // 本控制器的 `close` / `setTab` 等是**裸引用**直接传给视图层的
    // （`App.ts` 里 `onClose: ctrl.settings.close`），脱离实例调用时 this 会丢。
    // 与 sessions / composer / graph / files / layout 同口径：按原型全量绑定，
    // 而不是手写一份绑定清单（手写清单在本仓已经漂过一次，见 controllerBindings 判据）。
    MethodBinder.bindAll(this);
  }

  /**
   * 打开工作台控制台（设置自 2026-10-17 起是左栏页脚按钮 + 独立页面，不再是右栏面板；
   * 2026-10-26 起与功能面板共用 `components/console/ConsoleModal.tsx`）。
   * @param tab 打开时定位到哪一栏（缺省保持上次选择）
   * @returns 无
   */
  public open(tab?: SettingsTabKey): void {
    // 设置与功能面板共用同一个控制台：打开设置时必须退出面板态，
    // 否则两个开关同为 true 时 `active` 的优先级会让"用命令面板打开某个面板"看起来没反应。
    this.host.patch(
      tab === undefined
        ? { settingsOpen: true, panelModalOpen: false }
        : { settingsOpen: true, settingsTab: tab, panelModalOpen: false },
    );
  }

  /**
   * 关闭设置页（控制台由调用方一并关闭）。
   * @returns 无
   */
  public close(): void {
    this.host.patch({ settingsOpen: false });
  }

  /**
   * 切换控制台内的设置分栏（受控：供"从审批弹窗跳到权限"这类外部驱动）。
   * @param tab 分栏 key
   * @returns 无
   */
  public setTab(tab: SettingsTabKey): void {
    this.host.patch({ settingsTab: tab });
  }

  /**
   * 打开设置并定位到「权限」栏。
   *
   * 原实现是 `openPane('settings')`——打开一个**已经不存在**的面板 key（settings 已从
   * `PanelRegistry` 移除），会静默落到默认面板（工具）⇒ 审批弹窗里的「更改权限」点了没反应。
   * 这条路径现在指向控制台的权限页。
   * @returns 无
   */
  public openPermission(): void {
    this.open('permission');
  }

  /**
   * 切换界面语言：布局控制器管「模块态 + localStorage + App 状态」（即时生效），
   * 这里补「服务端配置落盘」——locale 与 model/approval 同走 `config.update` 持久化到
   * 用户级 omniharness.json（做成配置，跨设备一致；落盘失败只影响持久化，不回滚本次切换）。
   * @param l 目标语言
   * @returns 无
   */
  public setLocale(l: Locale): void {
    this.deps.layout.setLocale(l);
    this.deps.api.updateConfig({ locale: l }).catch(() => {
      /* 静默：语言已生效，持久化失败不打断用户 */
    });
  }

  /**
   * 用服务端配置里的 locale 初始化界面语言（mount 时调用一次）。
   *
   * 只在值合法时应用：服务端配置可被手改，非法值（或缺失）保持当前语言不动，
   * 而不是回落成某个"猜"的语言。
   * @param value 服务端配置里的 locale（unknown：来自 JSON，必须窄化）
   * @returns 无
   */
  public applyConfigLocale(value: unknown): void {
    if (value === 'zh' || value === 'en') this.deps.layout.setLocale(value);
  }
}
