import * as React from 'react';
import { claimPopover, releasePopover } from '../models/PopoverStack.ts';

/**
 * 弹层展开期间的生命周期：点外部关闭 + 互斥登记。
 *
 * 本仓有四处弹层（+ 菜单、模型选择、权限选择、容量面板）都手写同一段 effect：打开时
 * `window.addEventListener('click', close)` 并 `claimPopover`，收起/卸载时对称摘除。
 * 四份拷贝最容易漂移的是清理顺序与 `releasePopover` 的遗漏（漏掉会让别的弹层永远打不开）。
 *
 * 用 ref 固定最新的 close 回调：调用方每次渲染传新箭头函数也不会反复重挂监听
 *（挂载/摘除只随 `open` 与 `id` 变化）。
 *
 * @param open 是否展开
 * @param close 关闭动作（通常 `() => setOpen(false)`）
 * @param id 互斥控制器里的弹层身份
 * @returns 无
 */
export function usePopoverEffect(open: boolean, close: () => void, id: string): void {
  const closeRef = React.useRef(close);
  closeRef.current = close;
  React.useEffect(() => {
    if (!open) return undefined;
    const onClose = (): void => closeRef.current();
    window.addEventListener('click', onClose);
    // 互斥：登记"我是当前弹层"，被别的弹层顶掉时自动收起（见 PopoverStack 头注释）。
    claimPopover({ id, close: onClose });
    return () => {
      window.removeEventListener('click', onClose);
      releasePopover(id);
    };
  }, [open, id]);
}
