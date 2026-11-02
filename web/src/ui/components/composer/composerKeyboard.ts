// 输入区键盘处理：补全弹层打开时接管方向键 / Enter / Tab / Esc，避免误发送；否则 Enter 发送。
//
// 抽成模块级纯函数（无 React 状态，只读写传入的补全接口）后，Composer 里只剩一行接线；
// 行为与原 `onKeyDown` 逐分支一致（顺序：`/` 优先 → `@` → 发送）。

import type * as React from 'react';
import { MentionResolver } from '../../models/MentionResolver.ts';
import type { ComposerCompletions } from './useComposerCompletions.ts';

/**
 * 键盘：补全打开时接管方向键 / Enter / Tab / Esc，避免误发送；否则 Enter 发送。
 * @param e 键盘事件
 * @param completions 补全态与操作
 * @param onSubmit 提交（Enter 且无 Shift）
 * @returns 无
 */
export function handleComposerKeyDown(
  e: React.KeyboardEvent,
  completions: ComposerCompletions,
  onSubmit: () => void,
): void {
  const { slash, mention } = completions;
  if (slash !== null && slash.items.length > 0) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      completions.setSlash({
        ...slash,
        idx: MentionResolver.move(slash.idx, slash.items.length, e.key === 'ArrowDown' ? 1 : -1),
      });
      return;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      completions.applySlash(slash.items[slash.idx] ?? slash.items[0]!);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      completions.setSlash(null);
      return;
    }
  }
  if (mention !== null && mention.items.length > 0) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      completions.setMention({
        ...mention,
        idx: MentionResolver.move(
          mention.idx,
          mention.items.length,
          e.key === 'ArrowDown' ? 1 : -1,
        ),
      });
      return;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      completions.applyMention(mention.items[mention.idx] ?? '');
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      completions.setMention(null);
      completions.setSlash(null);
      return;
    }
  }
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    onSubmit();
  }
}
