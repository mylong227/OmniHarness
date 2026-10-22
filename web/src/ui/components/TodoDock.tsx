import * as React from 'react';
import { type TodoDockItem } from '../models/TodoDockModel.ts';
import { t } from '../i18n/i18n.ts';

/** 面板属性。 */
export interface TodoDockProps {
  /** 当前待办；null/空时不渲染。 */
  readonly items: readonly TodoDockItem[] | null;
}

/**
 * 输入框上方的计划进度条：始终显示「已完成/总数 + 当前进行项」，展开可看全量。
 *
 * 为什么需要：todo 事件原先只在流里出现一次，长会话滚上去就看不见；用户需要一个
 * 不用滚动就能知道「Agent 现在做到哪一步」的稳定位置。
 */
export function TodoDock({ items }: TodoDockProps): React.ReactElement | null {
  if (items === null || items.length === 0) return null;
  const done = items.filter((item) => item.status === 'completed').length;
  const current = items.find((item) => item.status === 'in_progress');
  const pending = items.filter((item) => item.status === 'pending').length;
  const percent = Math.round((done / items.length) * 100);
  return (
    <details className="todo-dock" open={current !== undefined}>
      <summary className="todo-dock__summary">
        <span className="todo-dock__title">{t('计划')}</span>
        <span className="todo-dock__count">
          {done}/{items.length}
        </span>
        <span className="todo-dock__bar" aria-hidden="true">
          <span className="todo-dock__fill" style={{ width: `${String(percent)}%` }} />
        </span>
        <span className="todo-dock__current">
          {current?.content ?? (pending > 0 ? t('待处理 {n} 项', { n: pending }) : t('全部完成'))}
        </span>
      </summary>
      <ul className="todo-dock__list">
        {items.map((item, index) => (
          <li key={`${String(index)}-${item.content}`} className={`todo-dock__item is-${item.status}`}>
            <span className="todo-dock__mark" aria-hidden="true">
              {item.status === 'completed' ? '✓' : item.status === 'in_progress' ? '◐' : '○'}
            </span>
            {item.content}
          </li>
        ))}
      </ul>
    </details>
  );
}
