// 设置页「键盘快捷键」栏：全局绑定（由绑定表生成，杜绝提示与行为漂移）+ 输入框按键。
//
// 2026-11-02 从 `SettingsSurface` 抽出（`check.mjs` 函数体行数铁律：原 `renderShortcuts`
// 一个箭头函数 22 行；抽出的目的只是让容器保持薄组合，展示内容逐字未改）。

import { t } from '../../i18n/i18n.ts';
import { KeyboardShortcuts, type ShortcutAction } from '../../models/KeyboardShortcuts.ts';
import { ConsoleCard, ConsoleRow } from './ConsoleUI.tsx';

/** 全局快捷键的展示顺序与说明（组合键文案取 `KeyboardShortcuts.label`，不另抄一份）。 */
const GLOBAL_SHORTCUTS: readonly { action: ShortcutAction; label: string }[] = [
  { action: 'palette', label: '打开命令面板' },
  { action: 'newSession', label: '新建会话' },
  { action: 'toggleLeft', label: '收起 / 展开会话栏' },
  { action: 'toggleRight', label: '收起 / 展开右侧面板' },
  { action: 'toggleTheme', label: '切换明暗主题' },
];

/** 全局快捷键解析器只用于取展示文案（无状态，模块级单例）。 */
const SHORTCUT_LABELS = new KeyboardShortcuts();

/** 输入框 / 浮层的内置按键（不经过全局绑定表，但确实由组件实现）。 */
const INPUT_KEYS: readonly { combo: string; label: string }[] = [
  { combo: 'Enter', label: '发送消息（输入框）' },
  { combo: 'Shift+Enter', label: '换行（输入框）' },
  { combo: 'Esc', label: '关闭浮层 / 对话框' },
  { combo: '↑ / ↓', label: '在浮层与选择器里移动' },
  { combo: 'Tab', label: '在控制台与对话框内循环焦点' },
];

/**
 * 「键盘快捷键」栏：全局绑定 + 输入框与浮层按键（均为只读展示）。
 * @returns 快捷键页节点
 */
export function SettingsShortcutsPane(): ReactElement {
  return (
    <>
      <ConsoleCard
        title={t('全局快捷键')}
        description={t('快捷键是只读展示：本版本不提供自定义键位，避免与浏览器保留键冲突。')}
      >
        {GLOBAL_SHORTCUTS.map((row) => (
          <ConsoleRow key={row.action} label={t(row.label)}>
            <kbd className="csl-kbd">{SHORTCUT_LABELS.label(row.action)}</kbd>
          </ConsoleRow>
        ))}
      </ConsoleCard>
      <ConsoleCard title={t('输入框与浮层')} description={t('这些键由各自的组件实现，不是全局监听。')}>
        {INPUT_KEYS.map((row) => (
          <ConsoleRow key={row.combo} label={t(row.label)}>
            <kbd className="csl-kbd">{row.combo}</kbd>
          </ConsoleRow>
        ))}
      </ConsoleCard>
    </>
  );
}
