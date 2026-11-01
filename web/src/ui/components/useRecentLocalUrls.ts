// 会话里出现过的本地开发地址（dev server / 预览链接）：给网页标签空态做一键入口。
// 从 App.ts 抽出（2026-11-01 前端性能批）：逻辑不变，只是把「倒扫最近若干条」的 useMemo
// 挪进独立 hook——App() 函数体有 80 行上限，这段带注释占 20+ 行。

import * as React from 'react';
import { LocalDevUrls } from '../models/LocalDevUrls.ts';
import type { ThreadEvent } from '../../types/models.ts';
import type { ToolResultView } from '../shared.ts';

/**
 * 从最近的事件与工具结果里收集本地开发地址（App 级 useMemo，依赖事件/结果数组身份）。
 * @param events 会话事件流（倒扫最近若干条，不做全量正则——长会话里那是可见的卡顿源）
 * @param toolResults 工具结果表（倒扫最近若干条）
 * @returns 本地地址列表（最多 6 条；已排除当前站点自身）
 */
export function useRecentLocalUrls(
  events: readonly ThreadEvent[],
  toolResults: Readonly<Record<string, ToolResultView>>,
): readonly string[] {
  return React.useMemo(() => {
    const texts: string[] = [];
    for (let i = events.length - 1; i >= 0 && texts.length < 24; i -= 1) {
      const ev = events[i];
      if (ev !== undefined && ev.type === 'assistant') {
        texts.push(String(ev.payload?.content ?? ''));
      }
    }
    const results = Object.values(toolResults);
    for (let i = results.length - 1; i >= 0 && texts.length < 36; i -= 1) {
      texts.push(results[i]?.text ?? '');
    }
    return LocalDevUrls.collect(texts, {
      limit: 6,
      excludeHostPort: typeof location === 'undefined' ? '' : location.host,
    });
  }, [events, toolResults]);
}
