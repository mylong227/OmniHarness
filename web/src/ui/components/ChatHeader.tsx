// 中栏头（截图式三栏壳）：会话标题 + 忙碌徽标 + 「对话 / 轨迹」视图切换。
// 取代原全局 TopBar 在中栏的位置；移动端抽屉开关（左栏 / 右栏）也收编在这两枚仅窄屏显示的按钮里。
// 视图切换是组件内局部状态吗——不是：视图由父组件（StreamView）持有，切到「轨迹」要换整个流区。
// 纯展示组件（函数组件范式）：展示 + 回调，无内部状态、无副作用。

import { icon } from '../models/Icon.ts';
import { t } from '../i18n/i18n.ts';

/** 中栏视图（对话流 / 工具轨迹）。 */
export type ChatViewKind = 'chat' | 'trace';

/** ChatHeader 组件的入参。 */
export interface ChatHeaderProps {
  /** 当前会话标题（未命名会话显示占位）。 */
  title: string;
  /** 回合进行中——显示忙碌徽标（诚实口径：有多少显示多少，不虚构后台任务数）。 */
  busy: boolean;
  /** 当前视图。 */
  view: ChatViewKind;
  /** 切换视图。 */
  onView: (v: ChatViewKind) => void;
  /** 打开左栏抽屉（仅窄屏渲染）。 */
  onToggleLeft?: () => void;
  /** 切换右栏（桌面=收起/展开面板；移动=抽屉）。未提供则不渲染。 */
  onToggleRight?: () => void;
  /** 右栏当前是否处于收起态（切换按钮的高亮/文案）。 */
  rightCollapsed?: boolean;
}

/** 「对话 / 轨迹」两个视图的静态清单（渲染顺序即展示顺序）。 */
const VIEWS: readonly { key: ChatViewKind; label: string }[] = [
  { key: 'chat', label: '对话' },
  { key: 'trace', label: '轨迹' },
];

/**
 * 中栏头：标题行 + 视图标签（WAI-ARIA Tabs 的 tablist / tab + aria-selected）。
 * @param props 组件入参
 * @returns 中栏头节点
 */
export function ChatHeader(props: ChatHeaderProps): ReactElement {
  const { title, busy, view, onView, onToggleLeft, onToggleRight, rightCollapsed } = props;
  return (
    <div className="chat-head">
      {onToggleLeft === undefined ? null : (
        <button
          className="iconbtn mob-only"
          title={t('会话侧栏')}
          aria-label={t('打开会话侧栏')}
          onClick={onToggleLeft}
        >
          {icon('menu', { size: 16 })}
        </button>
      )}
      <div className="chat-title" title={title}>
        {title === '' ? t('新会话') : title}
      </div>
      {busy ? (
        <span className="chat-busy" role="status">
          <span className="wi-dot" aria-hidden="true"></span>{t('任务进行中')}
        </span>
      ) : null}
      <span className="flex-spacer" aria-hidden="true"></span>
      <div className="chat-tabs" role="tablist" aria-label={t('中栏视图')}>
        {VIEWS.map((v) => (
          <button
            key={v.key}
            role="tab"
            aria-selected={view === v.key ? 'true' : 'false'}
            className={'chat-tab' + (view === v.key ? ' active' : '')}
            onClick={() => onView(v.key)}
          >
            {t(v.label)}
          </button>
        ))}
      </div>
      <span className="flex-spacer" aria-hidden="true"></span>
      {onToggleRight === undefined ? null : (
        <button
          // 2026-10-21（用户按截图「按钮去掉换成小箭头形式」）：原来是 `columns` 图标 + `.active`
          // 的淡色底块，看着像一枚「选中态视图」；它其实是「把右栏推到右边 / 拉回来」的开关，
          // 故改成与左栏「«」、右栏头「»」同源的**纯字形小箭头**，也不再加 `.active` 底块。
          className="iconbtn chat-panel-toggle"
          title={rightCollapsed ? t('展开功能面板（Ctrl/Cmd+Shift+E）') : t('收起功能面板（Ctrl/Cmd+Shift+E）')}
          aria-label={rightCollapsed ? t('展开功能面板') : t('收起功能面板')}
          aria-expanded={rightCollapsed ? 'false' : 'true'}
          onClick={onToggleRight}
        >
          {rightCollapsed ? '«' : '»'}
        </button>
      )}
    </div>
  );
}
