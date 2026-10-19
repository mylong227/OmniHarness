// 「全部面板」入口：只保留一枚触发按钮。
//
// 2026-10-19 起不再弹下拉菜单，而是打开设置式的 `PanelModal`（左导航 + 右内容）——
// 用户原话：「点击按钮不要弹出这个下拉面板了，而是像设置按钮一样弹窗、分左右显示」。
// 菜单相关的定位 / 外部点击 / 滚动关闭逻辑随之删除（模态自己处理遮罩与 Esc）。

import { icon } from '../models/Icon.ts';
import { t } from '../i18n/i18n.ts';

/** PanelPicker 组件的入参。 */
export interface PanelPickerProps {
  /** 打开面板模态。 */
  onOpen: () => void;
}

/**
 * 「全部面板」按钮：点开面板模态。
 * @param props 组件入参
 * @returns 触发按钮节点
 */
export function PanelPicker(props: PanelPickerProps): ReactElement {
  const { onOpen } = props;
  return (
    <div className="pp-wrap">
      <button
        className="iconbtn pp-btn"
        title={t('全部面板')}
        aria-label={t('全部面板')}
        aria-haspopup="dialog"
        onClick={onOpen}
      >
        <span aria-hidden="true">{icon('columns', { size: 16 })}</span>
      </button>
    </div>
  );
}
