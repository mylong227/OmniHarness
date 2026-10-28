// 模态的焦点收拢与归还（从两个选择器的组件体里抽出来）。
//
// ## 它负责什么
//
// 1. 打开时把焦点从背后的输入框收进模态（否则 Enter 会继续发给输入区）；
// 2. 关闭/卸载时把焦点还给**打开它的那个控件**（键盘用户不会"丢焦点"）；
// 3. Tab / Shift+Tab 在模态内绕圈（复用 `models/focusTrap.ts` 的 `trapTab`）。
//
// ## 为什么抽成 hook
//
// 两个选择器（文件 / 文件夹）的这段逻辑逐字相同，而组件体已逼近 `check.mjs` 的函数体上限；
// 复制一份就是两份增长。Esc 不在这里处理：两个选择器的 Esc 语义不同（文件选择器关弹窗；
// 文件夹选择器要区分「新建态退新建」与「浏览态关弹窗」），留在各自的既有通道。

import * as React from 'react';
import { trapTab } from '../models/focusTrap.ts';

/** 模态焦点接线。 */
export interface ModalFocus {
  /** 挂到模态根元素上（需带 `tabIndex={-1}`）。 */
  readonly modalRef: React.MutableRefObject<HTMLDivElement | null>;
  /** 挂到模态根元素的 `onKeyDown`：只接管 Tab。 */
  readonly onKeyDown: (e: React.KeyboardEvent) => void;
}

/**
 * 模态焦点收拢 / 归还 / Tab 陷阱。
 * @returns 模态 ref 与按键处理
 */
export function useModalFocus(): ModalFocus {
  const modalRef = React.useRef<HTMLDivElement | null>(null);
  const openerRef = React.useRef<HTMLElement | null>(null);
  React.useEffect(() => {
    openerRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    modalRef.current?.focus();
    return () => {
      openerRef.current?.focus();
    };
  }, []);
  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key !== 'Tab') return;
    if (trapTab(modalRef.current, e.shiftKey)) e.preventDefault();
  };
  return { modalRef, onKeyDown };
}
