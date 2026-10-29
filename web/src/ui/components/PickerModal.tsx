// 文件 / 目录选择器的共享浮层壳（antd Modal）。
//
// 2026-10-29（W2）：两个选择器原先各写一套 `<div class="fp-overlay"><div class="fp-modal"
// role="dialog" ...>` + 自研焦点陷阱（`useModalFocus`）。这里收敛成一个壳：
//   · 遮罩、层级、进入/退出动画、焦点圈定与**归还 opener** 交给 antd Modal；
//   · 选择器自己的浏览/勾选/新建流程与 `.fp-*` 内容结构原样保留（它们才是业务）。
//
// 两处 antd 行为需要补：
//   ① Modal 不转发 `aria-label`（只认 title，而这里要自定义头部）⇒ ref 回调在节点进树时
//      把名字写到真正的 dialog 元素上（真机上 Modal 子节点挂载晚于布局 effect，实测过）；
//   ② Esc 用 `keyboard={false}`：两个选择器各自已有 window 级 Esc 处理，交给 Modal 会关两次。

import * as React from 'react';
import { Modal } from 'antd';
import { icon } from '../models/Icon.ts';
import { t } from '../i18n/i18n.ts';

/** 选择器壳的入参。 */
export interface PickerModalProps {
  /** 弹窗标题（同时作为 dialog 的可访问名）。 */
  title: string;
  /** 取消 / 关闭。 */
  onCancel: () => void;
  /** 弹窗内容（路径栏 / 列表 / 动作）。 */
  children: React.ReactNode;
}

/** 遮罩与焦点配置：**必须是稳定引用**——每次渲染新建对象会让 antd 的 effect 反复重跑
 *（实测引发渲染循环，最终 `Array buffer allocation failed` 把测试进程打崩）。 */
const MASK = { closable: true };
const FOCUSABLE = { trap: true, focusTriggerAfterClose: true };

/**
 * 选择器浮层壳。
 * @param props 标题、关闭回调与内容
 * @returns 弹窗节点
 */
export function PickerModal(props: PickerModalProps): ReactElement {
  const { title, onCancel, children } = props;
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const nameDialog = React.useCallback(
    (node: HTMLDivElement | null): void => {
      rootRef.current = node;
      if (node === null) return;
      const dialog = node.closest('[role="dialog"]');
      if (dialog === null) return;
      dialog.setAttribute('aria-label', title);
    },
    [title],
  );

  // 打开即把焦点收进弹窗。antd 的聚焦要等 transition 结束（jsdom 里永远等不到），
  // 而「焦点还在背后输入框」会让 Enter 直接落进 Composer ⇒ 自己补一次下一帧聚焦。
  // 顺带把 opener 记下来：直接卸载（不是走关闭动画）时 antd 不会归还焦点，这里对称归还。
  React.useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const timer = setTimeout(() => {
      const dialog = rootRef.current?.closest('[role="dialog"]');
      if (dialog instanceof HTMLElement) dialog.focus();
    }, 0);
    return () => {
      clearTimeout(timer);
      if (opener !== null && opener.isConnected) opener.focus();
    };
  }, []);

  return (
    <Modal
      open
      onCancel={onCancel}
      footer={null}
      closable={false}
      keyboard={false}
      mask={MASK}
      // 焦点圈定与「关闭后归还 opener」由 antd 承担（v6 用 focusable.trap，旧 sentinel 已移除）。
      focusable={FOCUSABLE}
      width={720}
      className="fp-modal"
      destroyOnHidden
    >
      <div className="fp-shell" ref={nameDialog}>
        <div className="fp-head">
          <span className="fp-title">{title}</span>
          <button className="fp-close" title={t('关闭 (Esc)')} onClick={onCancel}>
            {icon('x', { size: 14 })}
          </button>
        </div>
        {children}
      </div>
    </Modal>
  );
}
