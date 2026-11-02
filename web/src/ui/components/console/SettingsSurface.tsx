// 控制台里的「设置页」：常规 / 模型与厂商 / 运行时 / 权限 / 桌面 / 键盘快捷键。
//
// 2026-10-29（用户按截图要求）：删除「外观」页签，主题与两栏宽度并入「常规」。
//
// 状态事实源仍是 `models/SettingsModel.ts`（零 React，可单测）；本文件只负责：
//   ① 生命周期（首次装载、卸载释放、厂商目录加载）；
//   ② 把快照映射成控制台卡片（ConsoleCard / ConsoleRow / ConsoleSettingRow）；
//   ③ 厂商卡片的折叠与忙碌标记（纯 UI 状态）。
//
// 2026-10-26 从 `SettingsModal` 抽出：设置不再是独立模态，而是控制台的一类页面。
// 页面标题与分组由 `ConsoleModal` 统一渲染，本文件不再画顶栏 / 左导航。
//
// 2026-11-02（S2 长函数债务清理）：原来 499 行的 `SettingsSurface` 拆成
//   · `useSettingsSurfaceModel`（模型生命周期）
//   · `useProviderCatalog`（厂商目录 / Key / 检测 / 启用）
//   · `SettingsGeneralPane` / `SettingsModelPane` / `SettingsRuntimePane` /
//     `SettingsPermissionPane` / `SettingsShortcutsPane`（各栏展示）
// 本文件退化为薄组合；行为、DOM 结构、class 名、aria 与 i18n 文案均未改动。

import { useApp } from '../../context.ts';
import { t, type Locale } from '../../i18n/i18n.ts';
import type { ThemePreference } from '../../models/ThemePreference.ts';
import type { ThemeScheme } from '../../theme/palette.ts';
import type { SettingsTabKey } from '../../models/SettingsModel.ts';
import type { ChatMode } from '../../models/ChatModePreference.ts';
import { DesktopSettingsSection } from '../settings/DesktopSettingsSection.tsx';
import { SettingsGeneralPane } from './SettingsGeneralPane.tsx';
import { SettingsModelPane } from './SettingsModelPane.tsx';
import { SettingsRuntimePane } from './SettingsRuntimePane.tsx';
import { SettingsPermissionPane } from './SettingsPermissionPane.tsx';
import { SettingsShortcutsPane } from './SettingsShortcutsPane.tsx';
import { useSettingsSurfaceModel } from './useSettingsSurfaceModel.ts';
import { useProviderCatalog, type ProviderCatalogState } from './useProviderCatalog.ts';
import type { Config } from '../../../types/models.ts';
import type { SettingsModel } from '../../models/SettingsModel.ts';

/** 设置页的入参。 */
export interface SettingsSurfaceProps {
  /** 当前设置页。 */
  tab: SettingsTabKey;
  /** 当前实际生效的主题（系统模式下会随系统变化）。 */
  theme: 'dark' | 'light';
  /** 主题偏好。 */
  themePref: ThemePreference;
  /** 设置主题偏好。 */
  onThemePrefChange: (pref: ThemePreference) => void;
  /** 主题色方案（靛墨 / 苔青 / 绛紫 / 琥珀 / 玫红）。 */
  schemePref: ThemeScheme;
  /** 切换主题色方案。 */
  onSchemePrefChange: (scheme: ThemeScheme) => void;
  /** 当前界面语言。 */
  locale: Locale;
  /** 切换界面语言。 */
  onLocaleChange: (locale: Locale) => void;
  /** 当前聊天模式（队列模式 / 插话模式）。 */
  chatMode: ChatMode;
  /** 切换聊天模式（立即生效并写入用户级配置）。 */
  onChatModeChange: (mode: ChatMode) => void;
  /** 当前工作区（只读展示）。 */
  workspacePath: string;
  /** 左栏会话列表是否显示全部项目。 */
  sessionScopeAll: boolean;
  /** 切换会话列表范围。 */
  onToggleSessionsScope: () => void;
  /** 会话栏宽度（px）。 */
  leftWidth: number;
  /** 右侧面板宽度（px）。 */
  rightWidth: number;
  /** 调整会话栏宽度。 */
  onLeftWidthChange: (width: number) => void;
  /** 调整右侧面板宽度。 */
  onRightWidthChange: (width: number) => void;
  /** 控制台内跳到另一页（如「查看快捷键」）。 */
  onNavigate: (key: string) => void;
}

/**
 * 配置装载失败条（整页只有占位符时，必须说清原因）。
 * @param props 失败原因与重试回调
 * @returns 错误条节点
 */
function LoadErrorBanner(props: { message: string; onRetry: () => void }): ReactElement {
  return (
    <div className="sp-load-error csl-banner" role="alert">
      <span>{props.message}</span>
      <button className="csl-btn" type="button" onClick={props.onRetry}>
        {t('重试')}
      </button>
    </div>
  );
}

/** 各栏内容分发的入参。 */
interface SettingsTabContentProps {
  /** 当前设置页。 */
  tab: SettingsTabKey;
  /** 设置页的完整入参（各栏自己取需要的字段）。 */
  surface: SettingsSurfaceProps;
  /** 厂商目录状态与动作。 */
  catalog: ProviderCatalogState;
  /** 设置模型（字段行读写通道）。 */
  settings: SettingsModel;
  /** 当前服务端配置。 */
  cfg: Config | null;
}

/**
 * 按 `tab` 渲染对应栏的内容（桌面页回落）。
 * @param props 组件入参
 * @returns 当前栏节点
 */
function SettingsTabContent(props: SettingsTabContentProps): ReactElement {
  const { tab, surface, catalog, settings, cfg } = props;
  if (tab === 'general') {
    return (
      <SettingsGeneralPane
        theme={surface.theme}
        themePref={surface.themePref}
        onThemePrefChange={surface.onThemePrefChange}
        schemePref={surface.schemePref}
        onSchemePrefChange={surface.onSchemePrefChange}
        locale={surface.locale}
        onLocaleChange={surface.onLocaleChange}
        chatMode={surface.chatMode}
        onChatModeChange={surface.onChatModeChange}
        workspacePath={surface.workspacePath}
        sessionScopeAll={surface.sessionScopeAll}
        onToggleSessionsScope={surface.onToggleSessionsScope}
        leftWidth={surface.leftWidth}
        rightWidth={surface.rightWidth}
        onLeftWidthChange={surface.onLeftWidthChange}
        onRightWidthChange={surface.onRightWidthChange}
        onNavigate={surface.onNavigate}
      />
    );
  }
  if (tab === 'model') return <SettingsModelPane catalog={catalog} cfg={cfg} settings={settings} />;
  if (tab === 'runtime') return <SettingsRuntimePane cfg={cfg} settings={settings} />;
  if (tab === 'permission') return <SettingsPermissionPane settings={settings} />;
  if (tab === 'shortcuts') return <SettingsShortcutsPane />;
  return <DesktopSettingsSection />;
}

/**
 * 设置页容器：装载一次配置，按 `tab` 渲染对应卡片。
 * @param props 组件入参
 * @returns 设置页节点
 */
export function SettingsSurface(props: SettingsSurfaceProps): ReactElement {
  const { tab } = props;
  const { api, toast, refreshModelCatalog } = useApp();
  const { settings, snapshot } = useSettingsSurfaceModel({ api, toast, refreshModelCatalog });
  const catalog = useProviderCatalog({
    api,
    tab,
    toast,
    refreshModelCatalog,
    onReloadSettings: () => settings.reload(),
    cfg: snapshot.cfg,
  });
  const statusText = snapshot.error !== '' ? snapshot.error : snapshot.savedHint;

  return (
    <div className="csl-settings">
      <div
        className={
          'csl-status-line' +
          (statusText === '' ? '' : ' on') +
          (snapshot.error === '' ? '' : ' err')
        }
        role="status"
        aria-live="polite"
      >
        {statusText}
      </div>
      {snapshot.loadError === '' ? null : (
        <LoadErrorBanner
          message={snapshot.loadError}
          onRetry={() => {
            void settings.load();
            catalog.reloadProviders();
          }}
        />
      )}
      <SettingsTabContent
        tab={tab}
        surface={props}
        catalog={catalog}
        settings={settings}
        cfg={snapshot.cfg}
      />
    </div>
  );
}
