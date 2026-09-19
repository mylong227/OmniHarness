// 用户消息卡：展示用户文本，支持内联编辑后「编辑重发」（把编辑文本作为新回合重发）。
// 编辑态为受控 textarea；保存/取消均 stopPropagation，避免误触对话流的钻取（onClick 在父级 .ev 上）。
// 函数组件范式：编辑态与草稿各用一个 useState。

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
  /** 编辑提交：编辑后的文本回传控制器重发。 */
  onEdit: (text: string) => void;
}

/**
 * 用户消息卡：展示消息文本；允许时提供内联编辑与「保存并重发」。
 * @param props 组件入参
 * @returns 用户消息节点（编辑态为受控 textarea）
 */
export function UserCard(props: UserCardProps): ReactElement {
  const { ev, canEdit, busy, onEdit } = props;
  const [editing, setEditing] = React.useState<boolean>(false);
  const [draft, setDraft] = React.useState<string>('');
  const text = (ev.payload?.content as string) || '';

  /** 进入编辑态：把当前文本灌入草稿。 */
  const startEdit = (): void => {
    setDraft(text);
    setEditing(true);
  };

  /** 保存：非空则回传编辑文本并重发，退出编辑态。 */
  const save = (): void => {
    const next = draft;
    setEditing(false);
    setDraft('');
    if (next.trim() !== '') onEdit(next);
  };

  /** 取消编辑：丢弃草稿，退出编辑态。 */
  const cancel = (): void => {
    setEditing(false);
    setDraft('');
  };

  /**
   * 草稿变更（受控 textarea）。
   * @param e 输入事件
   */
  const onDraftChange = (e: Event): void => {
    setDraft((e.target as HTMLTextAreaElement).value);
  };

  if (editing) {
    return (
      <>
        <div className="head">
          {badge('user')}
          <span className="time">{timeOf(ev.timestamp)}</span>
        </div>
        <div className={'card ' + ev.type}>
          <textarea
            className="user-edit"
            value={draft}
            onChange={onDraftChange}
            aria-label="编辑消息"
          />
          <div className="user-edit-actions">
            <button className="user-edit-save" onClick={save}>
              保存并重发
            </button>
            <button className="user-edit-cancel" onClick={cancel}>
              取消
            </button>
          </div>
        </div>
      </>
    );
  }
  return (
    <>
      <div className="head">
        {badge('user')}
        <span className="time">{timeOf(ev.timestamp)}</span>
        {canEdit && busy !== true ? (
          <button
            className="msg-act"
            title="编辑并重发"
            aria-label="编辑并重发"
            onClick={(e: MouseEvent) => {
              e.stopPropagation();
              startEdit();
            }}
          >
            ✎ 编辑
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
