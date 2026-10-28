import * as React from 'react';
import { claimPopover, releasePopover } from '../models/PopoverStack.ts';
import { ActivationKeys } from '../models/ActivationKeys.ts';
import { usePopoverEffect } from './usePopoverEffect.ts';
import { useMenuNavigation } from './useMenuNavigation.ts';

/**
 * 弹层触发器 + 菜单键盘导航的共享逻辑（2026-10-29，S2：权限/模型选择器逐字重复）。
 *
 * 只负责开合、互斥登记、焦点归还与 ↑/↓/Home/End 导航，不碰业务选择。
 * @param popoverId 互斥控制器里的身份。
 * @returns 开合态、引用与事件处理。
 */
export function usePopoverMenu(popoverId: string): {
  open: boolean;
  setOpen: (next: boolean) => void;
  triggerRef: React.RefObject<HTMLDivElement | null>;
  menu: ReturnType<typeof useMenuNavigation>;
  flip: () => void;
  toggle: (e: React.MouseEvent) => void;
  stopBubble: (e: React.MouseEvent) => void;
  closeAndReturnFocus: () => void;
  onTriggerKeyDown: (e: React.KeyboardEvent) => void;
} {
  const [open, setOpen] = React.useState<boolean>(false);
  const triggerRef = React.useRef<HTMLDivElement | null>(null);
  usePopoverEffect(open, () => setOpen(false), popoverId);

  const closeAndReturnFocus = (): void => {
    releasePopover(popoverId);
    setOpen(false);
    triggerRef.current?.focus();
  };

  const menu = useMenuNavigation({
    onEscape: closeAndReturnFocus,
    ensureOpen: () => {
      if (!open) flip();
    },
  });

  const flip = (): void => {
    const next = !open;
    if (next) {
      claimPopover({ id: popoverId, close: () => setOpen(false) });
      menu.setActiveItem(0);
    } else {
      releasePopover(popoverId);
    }
    setOpen(next);
  };

  const toggle = (e: React.MouseEvent): void => {
    e.stopPropagation();
    flip();
  };

  const stopBubble = (e: React.MouseEvent): void => {
    e.stopPropagation();
  };

  const onTriggerKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      releasePopover(popoverId);
      setOpen(false);
      return;
    }
    if (ActivationKeys.activate(e, flip)) {
      e.stopPropagation();
      return;
    }
    menu.onTriggerKey(e);
  };

  return {
    open,
    setOpen,
    triggerRef,
    menu,
    flip,
    toggle,
    stopBubble,
    closeAndReturnFocus,
    onTriggerKeyDown,
  };
}
