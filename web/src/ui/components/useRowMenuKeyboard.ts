import * as React from 'react';

/**
 * 会话行菜单（role=menu）的 WAI-ARIA 键盘模型（2026-10-29 W5 收口）。
 *
 * 打开即把焦点交给首个菜单项；↑/↓ 循环移动、Home/End 跳首尾（「配置」子分组展开/收起后
 * 自然入列/出列——items() 每次按键现查）。菜单关闭时把焦点还给触发它的会话行
 *（按 data-session-id，与会话行的落点标识同源；面板整体卸载时行已不在，查询自然落空）。
 *
 * 焦点不依赖菜单定位：贴边翻转在 useLayoutEffect 里另行处理，这里打开即聚焦。
 * @param menu 菜单状态（null = 关闭）
 * @param menuRef 菜单容器引用
 */
export function useRowMenuKeyboard<T extends HTMLElement>(
  menu: { readonly id: string } | null,
  menuRef: React.RefObject<T | null>,
): void {
  React.useEffect(() => {
    if (menu === null) return;
    const items = (): HTMLElement[] =>
      Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
    items()[0]?.focus();
    const onKey = (e: KeyboardEvent): void => {
      const list = items();
      if (list.length === 0) return;
      const current = document.activeElement as HTMLElement | null;
      const idx = current === null ? -1 : list.indexOf(current);
      let next = -1;
      if (e.key === 'ArrowDown') next = idx < 0 || idx === list.length - 1 ? 0 : idx + 1;
      else if (e.key === 'ArrowUp') next = idx <= 0 ? list.length - 1 : idx - 1;
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = list.length - 1;
      else return;
      e.preventDefault();
      list[next]?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      // 关闭（含 Escape / 点空白 / 重开）时归还焦点。
      const row = document.querySelector<HTMLElement>(`[data-session-id="${menu.id}"]`);
      row?.focus();
    };
  }, [menu, menuRef]);
}
