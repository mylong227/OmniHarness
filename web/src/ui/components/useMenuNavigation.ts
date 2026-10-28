// 菜单键盘导航的接线（roving tabindex + 方向键），从三个弹层的组件体里抽出来。
//
// ## 为什么是 hook 而不是重复三份
//
// 模型 / 权限 / 「＋」三个菜单的交互完全同构：一个活动项、方向键环绕、Home/End、Esc 收起并
// 归还焦点、触发器上按 ↑/↓ 直接展开落到首/末项。写在三个组件体里各要 ~50 行——而组件体
// 本来就逼近 `check.mjs` 的函数体上限（组件层 2026-10-28 起纳入体量口径，存量 49 个函数体
// 已冻结），重复三份等于三次增长。
//
// ## 边界
//
// 纯 DOM 查询 + 焦点移动，不持有业务状态：菜单开关与「收起时释放互斥」仍由各组件决定
// （通过 `onEscape` 回调）。

import * as React from 'react';
import { MenuFocusModel } from '../models/MenuFocusModel.ts';

/** 菜单导航依赖。 */
export interface MenuNavigationOptions {
  /** Esc 时执行（组件负责收起弹层 / 释放互斥 / 把焦点还给触发器）。 */
  readonly onEscape: () => void;
  /** 触发器上按 ↑ 或 ↓ 时先确保菜单已展开。 */
  readonly ensureOpen: () => void;
}

/** hook 返回值。 */
export interface MenuNavigation {
  /** 当前活动项（roving tabindex 的唯一落点）。 */
  readonly activeItem: number;
  /** 设置活动项（项 onFocus 时调用）。 */
  readonly setActiveItem: (index: number) => void;
  /** 菜单容器 ref（挂到含菜单项的最近容器上）。 */
  readonly menuRef: React.MutableRefObject<HTMLDivElement | null>;
  /** 菜单容器的 onKeyDown。 */
  readonly onMenuKeyDown: (e: React.KeyboardEvent) => void;
  /** 触发器 onKeyDown 里调用：↑/↓ 展开并落到首/末项并返回 true；其余按键返回 false。 */
  readonly onTriggerKey: (e: React.KeyboardEvent) => boolean;
}

/**
 * 菜单键盘导航。
 * @param options 收起回调与展开回调
 * @returns 菜单导航接线
 */
export function useMenuNavigation(options: MenuNavigationOptions): MenuNavigation {
  const [activeItem, setActiveItem] = React.useState<number>(0);
  const menuRef = React.useRef<HTMLDivElement | null>(null);
  const items = (): NodeListOf<HTMLElement> | undefined =>
    menuRef.current?.querySelectorAll<HTMLElement>('[data-menu-item]');

  const focusItem = (index: number): void => {
    const list = items();
    if (list === undefined || index < 0 || index >= list.length) return;
    setActiveItem(index);
    list[index]?.focus();
  };

  const onMenuKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      options.onEscape();
      return;
    }
    const action = MenuFocusModel.resolve(e.key);
    if (action === null) return;
    e.preventDefault();
    // 菜单是触发器的子节点：不阻断冒泡，触发器上同一套 ↑/↓ 处理会再执行一次。
    e.stopPropagation();
    const size = items()?.length ?? 0;
    if (size === 0) return;
    if (action === 'first' || action === 'last') {
      focusItem(MenuFocusModel.edge(size, action));
      return;
    }
    focusItem(MenuFocusModel.step(activeItem, size, action === 'prev'));
  };

  const onTriggerKey = (e: React.KeyboardEvent): boolean => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return false;
    e.preventDefault();
    e.stopPropagation();
    options.ensureOpen();
    const forward = e.key === 'ArrowDown';
    // 展开是异步提交的：下一帧再查 DOM（否则查到的是展开前的空列表）。
    window.setTimeout(() => {
      const size = items()?.length ?? 0;
      focusItem(forward ? 0 : MenuFocusModel.edge(size, 'last'));
    }, 0);
    return true;
  };

  return { activeItem, setActiveItem, menuRef, onMenuKeyDown, onTriggerKey };
}
