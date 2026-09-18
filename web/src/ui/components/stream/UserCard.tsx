// 用户消息卡：展示用户文本，支持内联编辑后「编辑重发」（把编辑文本作为新回合重发）。
// 编辑态为受控 textarea；保存/取消均 stopPropagation，避免误触对话流的钻取（onClick 在父级 .ev 上）。

import { React } from '../../deps.js';
import { AppComponent } from '../../base/AppComponent.js';
import { badge, timeOf, esc } from '../../format.js';
import type { ThreadEvent } from '../../../types/models.js';

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

interface UserCardState {
  editing: boolean;
  draft: string;
}

/** 用户消息卡（含内联编辑）。 */
export class UserCard extends AppComponent<UserCardProps, UserCardState> {
  constructor(props: UserCardProps) {
    super(props);
    this.state = { editing: false, draft: '' };
    this.startEdit = this.startEdit.bind(this);
    this.save = this.save.bind(this);
    this.cancel = this.cancel.bind(this);
    this.onDraftChange = this.onDraftChange.bind(this);
  }

  /** 进入编辑态：把当前文本灌入草稿。 @returns 无 */
  private startEdit(text: string): void {
    this.setState({ editing: true, draft: text });
  }

  /** 保存：非空则回传编辑文本并重发，退出编辑态。 @returns 无 */
  private save(): void {
    const text = this.state.draft;
    this.setState({ editing: false, draft: '' });
    if (text.trim() !== '') this.props.onEdit(text);
  }

  /** 取消编辑：丢弃草稿，退出编辑态。 @returns 无 */
  private cancel(): void {
    this.setState({ editing: false, draft: '' });
  }

  /** 草稿变更（受控 textarea）。 @param e 输入事件 @returns 无 */
  private onDraftChange(e: Event): void {
    const target = e.target as HTMLTextAreaElement;
    this.setState({ draft: target.value });
  }

  override render(): ReactElement {
    const { ev, canEdit, busy } = this.props;
    const text = (ev.payload?.content as string) || '';
    if (this.state.editing) {
      return (
        <>
          <div className="head">
            {badge('user')}
            <span className="time">{timeOf(ev.timestamp)}</span>
          </div>
          <div className={'card ' + ev.type}>
            <textarea
              className="user-edit"
              value={this.state.draft}
              onChange={this.onDraftChange}
              aria-label="编辑消息"
            />
            <div className="user-edit-actions">
              <button className="user-edit-save" onClick={this.save}>
                保存并重发
              </button>
              <button className="user-edit-cancel" onClick={this.cancel}>
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
                this.startEdit(text);
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
}
