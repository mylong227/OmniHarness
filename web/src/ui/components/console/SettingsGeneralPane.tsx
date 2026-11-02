// 设置页「常规」栏：界面语言、主题与主题色、聊天模式、两栏宽度、工作区与会话范围、
// 快捷键入口、产品信息。
//
// 2026-11-02 从 `SettingsSurface` 抽出（`check.mjs` 函数体行数铁律：原 `renderGeneral`
// 一个箭头函数 107 行）。这里只做展示与回调透传，状态仍全部由 `SettingsSurface` /
// 上层控制台持有；DOM 结构、class 名、aria 文案与 i18n 调用与抽出前逐字一致。

import * as React from 'react';
import { t, type Locale } from '../../i18n/i18n.ts';
import type { ThemePreference } from '../../models/ThemePreference.ts';
import type { ThemeScheme } from '../../theme/palette.ts';
import type { ChatMode } from '../../models/ChatModePreference.ts';
import { ConsoleCard, ConsoleInfoRow, ConsoleRow, ConsoleSegmented } from './ConsoleUI.tsx';

/** 主题三态（跟随系统 → 深色 → 浅色）。 */
const THEME_PREFS: readonly { key: ThemePreference; icon: 'monitor' | 'moon' | 'sun'; label: string }[] =
  [
    { key: 'system', icon: 'monitor', label: '跟随系统' },
    { key: 'dark', icon: 'moon', label: '深色' },
    { key: 'light', icon: 'sun', label: '浅色' },
  ];

/**
 * 主题色方案五选一（2026-10-31，用户口径）。色值事实源在 theme/palette.ts 的 SCHEMES，
 * 这里只列 id 与展示名；每套方案在明暗两套主题下各有自己的签名色（自动跟随主题模式）。
 */
const SCHEME_OPTIONS: readonly { key: ThemeScheme; label: string }[] = [
  { key: 'ink', label: '靛墨' },
  { key: 'moss', label: '苔青' },
  { key: 'plum', label: '绛紫' },
  { key: 'amber', label: '琥珀' },
  { key: 'rose', label: '玫红' },
  { key: 'graphite', label: '石墨' },
];

/**
 * 外观卡：主题模式（明暗三态）+ 主题色方案（五选一）。
 * @param props 主题偏好 / 方案偏好与各自的回调
 * @returns 两张外观设置卡
 */
function ThemeCards(props: {
  theme: 'dark' | 'light';
  themePref: ThemePreference;
  schemePref: ThemeScheme;
  onThemePrefChange: (pref: ThemePreference) => void;
  onSchemePrefChange: (scheme: ThemeScheme) => void;
}): ReactElement {
  return (
    <>
      <ConsoleCard>
        <ConsoleRow
          label={t('主题模式')}
          hint={
            props.themePref === 'system'
              ? t('当前跟随系统：{theme}', { theme: props.theme === 'light' ? t('浅色') : t('深色') })
              : t('已锁定为{theme}', { theme: props.theme === 'light' ? t('浅色') : t('深色') })
          }
        >
          <ConsoleSegmented
            ariaLabel={t('主题')}
            value={props.themePref}
            options={THEME_PREFS.map((pref) => ({
              value: pref.key,
              label: t(pref.label),
              icon: pref.icon,
            }))}
            onChange={(next) => props.onThemePrefChange(next)}
          />
        </ConsoleRow>
      </ConsoleCard>

      <ConsoleCard>
        <ConsoleRow
          label={t('主题色')}
          hint={t('签名色方案，明暗两套主题各有自己的配色，界面与代码高亮一起换肤。')}
        >
          <ConsoleSegmented
            ariaLabel={t('主题色')}
            value={props.schemePref}
            options={SCHEME_OPTIONS.map((s) => ({ value: s.key, label: t(s.label) }))}
            onChange={(next) => props.onSchemePrefChange(next)}
          />
        </ConsoleRow>
      </ConsoleCard>
    </>
  );
}

/**
 * 聊天模式卡（2026-10-31，用户需求 A/B）：队列模式 / 插话模式二选一。
 * @param props 当前模式与切换回调
 * @returns 聊天模式设置卡
 */
function ChatModeCard(props: {
  mode: ChatMode;
  onChange: (mode: ChatMode) => void;
}): ReactElement {
  return (
    <ConsoleCard
      title={t('聊天模式')}
      description={t(
        '任务执行中再次发送消息时的处理方式。两种模式都支持文字、语音、图片、视频、GIF、文件与链接。',
      )}
    >
      <ConsoleRow
        label={t('发送方式')}
        hint={t(
          '队列模式：进入排队，当前任务结束后按顺序逐条发送；插话模式：相关内容并入当前任务继续执行，完全无关的内容立即中断并转入新任务。',
        )}
      >
        <ConsoleSegmented
          ariaLabel={t('聊天模式')}
          value={props.mode}
          options={[
            { value: 'queue', label: t('队列模式'), icon: 'inbox' },
            { value: 'steer', label: t('插话模式'), icon: 'message' },
          ]}
          onChange={(next) => props.onChange(next)}
        />
      </ConsoleRow>
    </ConsoleCard>
  );
}

/**
 * 界面语言卡。
 * @param props 当前语言与切换回调
 * @returns 语言设置卡
 */
function LanguageCard(props: {
  locale: Locale;
  onLocaleChange: (locale: Locale) => void;
}): ReactElement {
  return (
    <ConsoleCard>
      <ConsoleRow label={t('界面语言')} hint={t('选择应用 UI 的显示语言。')}>
        <ConsoleSegmented
          ariaLabel={t('界面语言')}
          value={props.locale}
          options={[
            { value: 'zh', label: t('中文') },
            { value: 'en', label: 'English' },
          ]}
          onChange={(next) => {
            if (next !== props.locale) props.onLocaleChange(next);
          }}
        />
      </ConsoleRow>
    </ConsoleCard>
  );
}

/**
 * 两栏宽度卡（会话栏 / 右侧面板）。
 * @param props 当前宽度与调整回调
 * @returns 宽度设置卡
 */
function PanelWidthCards(props: {
  leftWidth: number;
  rightWidth: number;
  onLeftWidthChange: (width: number) => void;
  onRightWidthChange: (width: number) => void;
}): ReactElement {
  return (
    <ConsoleCard
      footer={t('这里与拖动分隔条改的是同一份本机偏好；窄屏（≤880px）下两栏是抽屉，宽度不生效。')}
    >
      <ConsoleRow
        label={t('会话栏宽度')}
        hint={t('范围 180–600 px，当前 {width} px', { width: props.leftWidth })}
      >
        <input
          className="csl-range"
          type="range"
          min={180}
          max={600}
          step={4}
          aria-label={t('会话栏宽度')}
          value={props.leftWidth}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
            props.onLeftWidthChange(Number(e.target.value))
          }
        />
      </ConsoleRow>
      <ConsoleRow
        label={t('右侧面板宽度')}
        hint={t('范围 180–760 px，当前 {width} px', { width: props.rightWidth })}
      >
        <input
          className="csl-range"
          type="range"
          min={180}
          max={760}
          step={4}
          aria-label={t('右侧面板宽度')}
          value={props.rightWidth}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
            props.onRightWidthChange(Number(e.target.value))
          }
        />
      </ConsoleRow>
    </ConsoleCard>
  );
}

/**
 * 工作区与会话范围卡。
 * @param props 工作区路径 / 会话范围与切换回调
 * @returns 工作区设置卡
 */
function WorkspaceCard(props: {
  workspacePath: string;
  sessionScopeAll: boolean;
  onToggleSessionsScope: () => void;
}): ReactElement {
  return (
    <ConsoleCard
      footer={t('工作区由启动参数或用户级配置决定，界面内不提供切换——改它等于换一整个项目上下文。')}
    >
      <ConsoleInfoRow label={t('当前工作区')} value={props.workspacePath === '' ? '—' : props.workspacePath} />
      <ConsoleRow
        label={t('会话列表范围')}
        hint={t('只影响左栏列表的筛选，不改变会话归属；「全部项目」会显示其它工作区的存档。')}
      >
        <ConsoleSegmented
          ariaLabel={t('会话列表范围')}
          value={props.sessionScopeAll ? 'all' : 'current'}
          options={[
            { value: 'current', label: t('当前项目') },
            { value: 'all', label: t('全部项目') },
          ]}
          onChange={(next) => {
            if ((next === 'all') !== props.sessionScopeAll) props.onToggleSessionsScope();
          }}
        />
      </ConsoleRow>
    </ConsoleCard>
  );
}

/**
 * 全局快捷键入口卡。
 * @param props 跳转回调
 * @returns 快捷键入口卡
 */
function ShortcutsLinkCard(props: { onNavigate: (key: string) => void }): ReactElement {
  return (
    <ConsoleCard>
      <ConsoleRow label={t('全局快捷键')} hint={t('命令面板、新建会话、左右栏开合、明暗切换。')}>
        <button className="csl-btn" type="button" onClick={() => props.onNavigate('shortcuts')}>
          {t('查看全部')}
        </button>
      </ConsoleRow>
    </ConsoleCard>
  );
}

/**
 * 产品信息卡（归属根 / 配置文件 / 会话存档位置）。
 * @returns 产品信息卡
 */
function ProductInfoCard(): ReactElement {
  return (
    <ConsoleCard
      footer={t('以上是默认位置；归属根由服务端 OMNI_HOME 决定（默认 ~/.omniharness），--workspace 只切项目。')}
    >
      <ConsoleInfoRow label={t('产品')} value="OmniHarness" />
      <ConsoleInfoRow label={t('配置文件')} value="<OMNI_HOME>/omniharness.json" />
      <ConsoleInfoRow label={t('会话存档')} value="<OMNI_HOME>/sessions/" />
    </ConsoleCard>
  );
}

/** 「常规」栏的入参（只包含这一栏真正用到的字段）。 */
export interface SettingsGeneralPaneProps {
  /** 当前实际生效的主题。 */
  theme: 'dark' | 'light';
  /** 主题偏好。 */
  themePref: ThemePreference;
  /** 设置主题偏好。 */
  onThemePrefChange: (pref: ThemePreference) => void;
  /** 主题色方案。 */
  schemePref: ThemeScheme;
  /** 切换主题色方案。 */
  onSchemePrefChange: (scheme: ThemeScheme) => void;
  /** 当前界面语言。 */
  locale: Locale;
  /** 切换界面语言。 */
  onLocaleChange: (locale: Locale) => void;
  /** 当前聊天模式。 */
  chatMode: ChatMode;
  /** 切换聊天模式。 */
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
 * 「常规」栏：语言、主题、聊天模式、两栏宽度、工作区、快捷键入口、产品信息。
 * @param props 组件入参
 * @returns 常规页节点
 */
export function SettingsGeneralPane(props: SettingsGeneralPaneProps): ReactElement {
  return (
    <>
      <LanguageCard locale={props.locale} onLocaleChange={props.onLocaleChange} />
      <ThemeCards
        theme={props.theme}
        themePref={props.themePref}
        schemePref={props.schemePref}
        onThemePrefChange={props.onThemePrefChange}
        onSchemePrefChange={props.onSchemePrefChange}
      />
      <ChatModeCard mode={props.chatMode} onChange={props.onChatModeChange} />
      <PanelWidthCards
        leftWidth={props.leftWidth}
        rightWidth={props.rightWidth}
        onLeftWidthChange={props.onLeftWidthChange}
        onRightWidthChange={props.onRightWidthChange}
      />
      <WorkspaceCard
        workspacePath={props.workspacePath}
        sessionScopeAll={props.sessionScopeAll}
        onToggleSessionsScope={props.onToggleSessionsScope}
      />
      <ShortcutsLinkCard onNavigate={props.onNavigate} />
      <ProductInfoCard />
    </>
  );
}
