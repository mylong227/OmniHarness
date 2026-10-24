// 功能面板模态（2026-10-19）：与设置模态同款「左导航 + 右内容」。
//
// ## 为什么从下拉菜单改成模态
//
// 用户原话：「点击按钮不要弹出这个下拉面板了，而是像设置按钮一样弹窗、分左右显示」。
// 下拉菜单只有 16 行文字，选中后面板挤在 300–400px 的右栏里；设置模态已经是全站
// 最成熟的「左侧分类 + 右侧内容」版式，面板复用它：左边是面板清单，右边是完整宽度的面板。
//
// ## 数据范围
//
// 标题右侧使用面板范围的 `.scope-chip`（会话 / 工作区 / 全局 / 服务端）与会话实时绿点，
// 让「这个面板的数据跟着什么走」在模态里同样可见。
//
// ## 几何契约（2026-10-23）
//
// 面板切换时**整窗尺寸必须恒定**：内容长短只决定「内容区滚不滚」，不决定模态高矮。
// 旧实现把高度交给内容（`height: auto`），切到长面板时整窗从 ~673px 长到 ~749px 并重新
// 居中；短面板之间还会因为 scope 徽标撞上全局 `.session` 行样式（display:flex + min-height:34px）
// 而上下抖 9px。现在的分工：
//   · `.panel-modal` 固定高 `min(760px, 86vh)`，宽 `min(880px, 92vw)`；
//   · `.sp-top` 基准 52px（scope 徽标不再影响顶栏高度）；
//   · `.sp-content` 独占滚动，并给滚动条留稳定槽位（有无滚动条时不横向位移）；
//   · 切面板时内容区滚动位置归零（否则会沿用上一个面板的 scrollTop，看起来像"跳了一下"）。
//
// 纯展示组件：开合、当前面板、内容节点都由 App 注入；本组件不请求数据。

import * as React from 'react';
import { icon } from '../models/Icon.ts';
import { PANELS } from '../models/PanelRegistry.ts';
import { panelScopeOf } from '../models/PanelScope.ts';
import { useApp } from '../context.ts';
import { t } from '../i18n/i18n.ts';

/** PanelModal 组件的入参。 */
export interface PanelModalProps {
  /** 是否打开。 */
  open: boolean;
  /** 当前面板 key。 */
  pane: string;
  /** 切换面板。 */
  onPick: (key: string) => void;
  /** 关闭模态。 */
  onClose: () => void;
  /** 右侧内容（App 按 pane 渲染好的面板节点）。 */
  children?: React.ReactNode;
}

/**
 * 功能面板模态：左侧面板清单 + 右侧面板内容，与设置模态同一套版式。
 * @param props 组件入参
 * @returns 模态节点（未打开时为 null）
 */
export function PanelModal(props: PanelModalProps): ReactElement | null {
  const { open, pane, onPick, onClose, children } = props;
  const { sessionId, sessionTick } = useApp();
  // 内容区滚动容器：切面板时把 scrollTop 归零（见文件头的「几何契约」）。
  const contentRef = React.useRef<HTMLDivElement | null>(null);
  // Esc 关闭（模态的键盘出口；遮罩点击是另一条）。必须在 `if (!open)` 之前调用。
  React.useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  // 切面板后回到内容顶部：新面板不该继承上一个面板的滚动位置。
  // 同时覆盖「关闭后重开」——重新打开时也从头读。
  // 用 useLayoutEffect 而不是 useEffect：在浏览器绘制前归零，切面板不会闪一帧旧滚动位置。
  React.useLayoutEffect(() => {
    if (!open) return;
    const el = contentRef.current;
    if (el !== null) el.scrollTop = 0;
  }, [open, pane]);
  if (!open) return null;
  const meta = panelScopeOf(pane);
  const scopeText =
    meta.scope === 'session'
      ? sessionId === null
        ? t('未选择会话')
        : t('本会话')
      : meta.scope === 'workspace'
        ? t('工作区')
        : meta.scope === 'server'
          ? t('服务端')
          : t('全局');
  const active = PANELS.find((p) => p.key === pane);
  return (
    <div className="sp-ovl" onClick={onClose}>
      <div
        className="sp panel-modal"
        role="dialog"
        aria-modal="true"
        aria-label={t('功能面板')}
        onClick={(e: React.MouseEvent) => e.stopPropagation()}
      >
        <div className="sp-top">
          <span className="sp-top-title">
            {icon('columns', { size: 14 })}
            {active === undefined ? t('面板') : t(active.label)}
          </span>
          {/* 修饰类加 `scope-` 前缀：`session` 是全局会话行的通用类名，
              裸用会让徽标吃到 `.session { display:flex; min-height:34px }`，顶栏随之长高 9px。 */}
          <span className={`scope-chip scope-${meta.scope}`} title={meta.hint}>
            {scopeText}
          </span>
          {meta.scope === 'session' ? (
            <span
              key={sessionTick}
              className={'live-dot' + (sessionId === null ? '' : ' on')}
              title={t('数据实时跟随会话（回合推进自动刷新）')}
              aria-hidden="true"
            />
          ) : null}
          <span className="flex-spacer" aria-hidden="true"></span>
          <button className="iconbtn" aria-label={t('关闭')} onClick={onClose}>
            {icon('x', { size: 15 })}
          </button>
        </div>
        <div className="sp-body">
          <nav className="sp-nav" aria-label={t('全部面板')}>
            {PANELS.filter((p) => p.key !== 'file').map((p) => (
              <button
                key={p.key}
                className={'sp-nav-item' + (p.key === pane ? ' on' : '')}
                data-pane={p.key}
                aria-current={p.key === pane ? 'page' : undefined}
                onClick={() => onPick(p.key)}
              >
                {icon(p.icon, { size: 13 })}
                {t(p.label)}
              </button>
            ))}
          </nav>
          <div ref={contentRef} className="sp-content panel-modal-content panel-surface">
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}
