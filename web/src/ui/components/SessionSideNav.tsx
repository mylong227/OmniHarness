// 左栏一等导航（从 SessionPanel 抽出）：新建任务 / 自动化 / 插件市场三颗按钮。
//
// 纯展示（函数组件范式）：只画按钮，行为全由宿主回调注入；图标条态只留图标。
// 注释里的口径保持原样——它们是「为什么长这样」的唯一记录，不要删。

import { icon } from '../models/Icon.ts';
import { t } from '../i18n/i18n.ts';

/**
 * 新建会话的平台快捷键文案（与 KeyboardShortcuts 的 Ctrl/Cmd+N 同一口径）。
 * @returns `⌘N`（Mac）或 `Ctrl+N`
 */
export function newChatKbd(): string {
  return /Mac|iPod|iPhone|iPad/.test(navigator.platform) ? '⌘N' : 'Ctrl+N';
}

/** SessionSideNav 组件的入参。 */
export interface SessionSideNavProps {
  /** 左栏是否已收成图标条（收起时只留图标）。 */
  readonly rail: boolean;
  /** 当前激活的右栏面板 key（「插件 / 设置」入口的高亮态）。 */
  readonly activePane?: string | undefined;
  /** 新建会话。 */
  readonly onNew: () => void;
  /** 打开右栏某面板（插件入口等走这里）。 */
  readonly onOpenPane?: ((key: string) => void) | undefined;
}

/**
 * 左栏一等导航：新建任务 + 自动化 + 插件市场。
 * @param props 组件入参
 * @returns 导航节点（三颗按钮的兄弟片段，不额外包一层 DOM）
 */
export function SessionSideNav(props: SessionSideNavProps): ReactElement {
  const { rail, activePane, onNew, onOpenPane } = props;
  const kbd = newChatKbd();
  return (
    <>
      {/* 新建任务：截图式一等按钮 + 快捷键提示（与 KeyboardShortcuts 的 Ctrl/Cmd+N 同一口径）。 */}
      <button
        className={rail ? 'new-chat compact' : 'new-chat'}
        onClick={onNew}
        title={t('新建会话')}
        // 可访问名必须包含全部可见文字（WCAG 2.5.3：aria-hidden 的 kbd 提示也算可见文本）。
        aria-label={`${t('新建任务')} ${kbd}`}
      >
        <span className="nc-ico" aria-hidden="true">
          {icon('plus', { size: 15 })}
        </span>
        {rail ? null : <span>{t('新建任务')}</span>}
        {rail ? null : (
          <span className="nc-kbd" aria-hidden="true">
            {kbd}
          </span>
        )}
      </button>
      {/* 自动化：截图式侧栏的一等导航项（打开右栏自动化面板）。 */}
      <button
        className={'side-item' + (activePane === 'automations' ? ' active' : '')}
        onClick={() => onOpenPane?.('automations')}
        aria-label={activePane === 'automations' ? t('自动化（当前页）') : t('自动化')}
      >
        <span className="si-ico" aria-hidden="true">
          {icon('workflow', { size: 16 })}
        </span>
        {rail ? null : <span>{t('自动化')}</span>}
      </button>
      {/* 插件市场：截图式侧栏的一等导航项（打开右栏插件面板）。 */}
      <button
        className={'side-item' + (activePane === 'plugins' ? ' active' : '')}
        onClick={() => onOpenPane?.('plugins')}
        aria-label={activePane === 'plugins' ? t('插件市场（当前页）') : t('插件市场')}
      >
        <span className="si-ico" aria-hidden="true">
          {icon('plug', { size: 16 })}
        </span>
        {rail ? null : <span>{t('插件市场')}</span>}
      </button>
    </>
  );
}
