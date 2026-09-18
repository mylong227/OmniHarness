// 助手消息卡：生成中做字符级渐进揭示（内容为真实文本，非伪造 token），
// 附附件 chip、外部链接卡片与一键复制。点击正文里的文件路径链接在右侧面板打开。

import { React } from '../../deps.js';
import { AppComponent } from '../../base/AppComponent.js';
import { badge, timeOf, esc, renderMarkdown } from '../../format.js';
import { extractUrls } from '../../textUtils.js';
import { TextRevealer } from '../../models/TextRevealer.js';
import { ClipboardCopier } from '../../models/ClipboardCopier.js';
import { AttachmentChips } from './AttachmentChips.js';
import { ExternalLinkCards } from './ExternalLinkCards.js';
import type { ThreadEvent, FileAttachment } from '../../../types/models.js';

export interface AssistantCardProps {
  ev: ThreadEvent;
  busy?: boolean;
  onOpenFile?: (p: string) => void;
  /**
   * 是否允许渐进揭示动画（缺省允许）。
   * 传 false 用于「这段正文刚刚已经逐字流过来了」——此时再揭一遍会从 40% 处往回跳，是可见的倒退。
   */
  animate?: boolean;
  /** 重新生成回调（仅最后一条助手消息挂载；点击「重新生成」用最后一条用户消息重发）。 */
  onRegenerate?: () => void;
  /** 定时器注入点（单测可替换；组件内默认用全局 setTimeout）。 */
  schedule?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
}

interface AssistantCardState {
  shown: string;
}

const COPY_BTN: Record<string, string> = {
  marginTop: '10px',
  background: 'transparent',
  border: '1px solid var(--border)',
  borderRadius: '6px',
  padding: '3px 10px',
  cursor: 'pointer',
  color: 'inherit',
  fontSize: '11px',
  alignSelf: 'flex-start',
};

/** 助手消息卡组件。 */
export class AssistantCard extends AppComponent<AssistantCardProps, AssistantCardState> {
  /** 渐进揭示器（生命周期内复用，卸载时停止）。 */
  private readonly revealer: TextRevealer;

  constructor(props: AssistantCardProps) {
    super(props);
    this.state = { shown: '' };
    this.revealer = new TextRevealer(
      (shown) => this.setState({ shown }),
      props.schedule ?? setTimeout,
    );
  }

  override componentDidMount(): void {
    this.startReveal();
  }

  override componentDidUpdate(prevProps: AssistantCardProps): void {
    const text = this.fullText();
    const prevText = (prevProps.ev.payload?.content as string) || '';
    if (text !== prevText || prevProps.busy !== this.props.busy || prevProps.animate !== this.props.animate) {
      this.startReveal();
    }
  }

  override componentWillUnmount(): void {
    this.revealer.stop();
  }

  private fullText(): string {
    return (this.props.ev.payload?.content as string) || '';
  }

  private startReveal(): void {
    this.revealer.start(this.fullText(), this.props.animate !== false && this.props.busy === true);
  }

  /** 点击正文中的文件链接：拦截跳转，改在右侧面板打开。 */
  private readonly onContentClick = (e: MouseEvent): void => {
    const { onOpenFile } = this.props;
    const target = e.target as HTMLElement | null;
    if (!target || !onOpenFile) return;
    const anchor = target.closest('a[data-file-path]') as HTMLElement | null;
    if (anchor) {
      e.preventDefault();
      e.stopPropagation();
      onOpenFile((anchor as unknown as { dataset: { filePath?: string } }).dataset.filePath || '');
    }
  };

  private readonly onCopy = (e: MouseEvent): void => {
    e.stopPropagation();
    void ClipboardCopier.copy(this.fullText());
  };

  override render(): ReactElement {
    const { ev } = this.props;
    const p = ev.payload || {};
    const full = this.fullText();
    const { shown } = this.state;
    return (
      <>
        <div className="head">
          {badge(ev.type)}
          <span className="time">{timeOf(ev.timestamp)}</span>
          {this.props.onRegenerate ? (
            <button
              className="msg-act"
              title="重新生成"
              aria-label="重新生成"
              onClick={(e: MouseEvent) => {
                e.stopPropagation();
                this.props.onRegenerate?.();
              }}
            >
              ↻ 重新生成
            </button>
          ) : null}
        </div>
        <div className={'card ' + ev.type}>
          <div className="content" spellCheck="false" onClick={this.onContentClick}>
            {renderMarkdown(shown || full)}
          </div>
          <AttachmentChips files={p.files as FileAttachment[] | undefined} />
          <ExternalLinkCards urls={extractUrls(full)} />
          <button className="copy-btn" title="复制结果" style={COPY_BTN} onClick={this.onCopy}>
            📋 复制
          </button>
        </div>
      </>
    );
  }
}
