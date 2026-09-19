// 用户消息卡：展示用户文本；末条用户消息挂载「编辑重发」入口。
// 编辑重发（F4）把该消息填回底部输入框（ComposerDraft），用户在输入框里改完直接回车即重发——
// 重发复用既有提交通路（turns.run），不新造 RPC，也不再维护第二套内联编辑器。
// 函数组件范式：无内部 state，纯展示 + 一个回调。

import { React } from '../../deps.js';
import { badge, timeOf, esc } from '../../format.js';
import type { ThreadEvent } from '../../../types/models.js';

/** UserCard 组件的入参。 */
export interface UserCardProps {
  /** 用户事件（payload.content 为消息文本）。 */
  ev: ThreadEvent;
  /** 回合进行中（编辑按钮在 busy 时隐藏，避免与生成态冲突）。 */
  busy?: boolean;
  /** 是否允许编辑（仅最后一条用户消息挂载）。 */
  canEdit: boolean;
  /** 编辑重发：把这条消息填回底部输入框。 */
  onEdit: () => void;
}

/**
 * 用户消息卡：展示消息文本；允许时提供「编辑重发」（填回输入框）。
 * @param props 组件入参
 * @returns 用户消息节点
 */
export function UserCard(props: UserCardProps): ReactElement {
  const { ev, canEdit, busy, onEdit } = props;
  const text = (ev.payload?.content as string) || '';
  return (
    <>
      <div className="head">
        {badge('user')}
        <span className="time">{timeOf(ev.timestamp)}</span>
        {canEdit && busy !== true ? (
          <button
            className="msg-act"
            title="编辑重发：把这条消息填回输入框，改完回车重发"
            aria-label="编辑重发"
            onClick={(e: MouseEvent) => {
              e.stopPropagation();
              onEdit();
            }}
          >
            ✎ 编辑重发
          </button>
        ) : null}
      </div>
      <div className={'card ' + ev.type}>
        <div className="content" spellCheck="false">
          {esc(text)}
        </div>
      </div>
    </>
  );
}
