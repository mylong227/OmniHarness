// 输入区文案与常量：占位符 / busy 态发送按钮三件文案 / 附件错误条样式。
//
// 抽成模块级纯函数是为了守住组件函数体的行数基线（check.mjs）：纯文案、无状态，
// 与聊天模式（队列 / 插话）同源，便于单测与复用。

import { t } from '../../i18n/i18n.ts';

/** FilePicker 错误条的固定外边距（原 Composer 内的 PICKER_ERR_BOX）。 */
export const PICKER_ERR_BOX: Record<string, string> = { margin: '6px 14px 0' };

/** busy 态发送按钮的三件文案（图标 / 可访问名 / 悬浮说明）。 */
export interface BusySendLabel {
  /** 按钮字形。 */
  readonly glyph: string;
  /** aria-label（可访问名）。 */
  readonly label: string;
  /** title（悬浮说明）。 */
  readonly title: string;
}

/**
 * 输入框占位符（随聊天模式变化：队列=入队，插话=并入/开新任务）。
 * @param busy 是否有回合在跑
 * @param mode 当前聊天模式（undefined 时按队列文案）
 * @returns 已本地化的占位符
 */
export function placeholderOf(busy: boolean | undefined, mode: 'queue' | 'steer' | undefined): string {
  if (busy !== true) return t('发消息或创建任务，/ 调用技能，@ 文件或对话');
  return mode === 'steer'
    ? t('任务进行中：Enter 插话；无关内容会中断并转新任务')
    : t('任务进行中：Enter 加入队列，结束后依次发送');
}

/**
 * busy 态发送按钮的三件文案（图标 / 可访问名 / 悬浮说明），按聊天模式区分。
 * @param mode 当前聊天模式（undefined 时按队列）
 * @returns 按钮属性
 */
export function busySendOf(mode: 'queue' | 'steer' | undefined): BusySendLabel {
  return mode === 'steer'
    ? { glyph: '↪', label: t('插话'), title: t('插话（Enter 发送，下一步生效）') }
    : {
        glyph: '＋',
        label: t('加入队列'),
        title: t('加入队列（Enter 发送，当前任务结束后依次发出）'),
      };
}
