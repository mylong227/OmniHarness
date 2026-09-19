// 助手消息卡：生成中做字符级渐进揭示（内容为真实文本，非伪造 token），
// 附附件 chip、外部链接卡片与一键复制。点击正文里的文件路径链接在右侧面板打开。
//
// 函数组件范式：揭示器实例跨渲染保持（useRef 惰性初始化），
// 「文本 / busy / animate 变化即重启」与「卸载即停止」分别由两个 effect 承接。

import { React } from '../../deps.js';
import { badge, timeOf, esc, renderMarkdown } from '../../format.js';
import { extractUrls } from '../../textUtils.js';
import { TextRevealer } from '../../models/TextRevealer.js';
import { ClipboardCopier } from '../../models/ClipboardCopier.js';
import { AttachmentChips } from './AttachmentChips.js';
import { ExternalLinkCards } from './ExternalLinkCards.js';
import type { ThreadEvent, FileAttachment } from '../../../types/models.js';

/** AssistantCard 组件的入参。 */
export interface AssistantCardProps {
  /** 助手事件（payload.content 为正文）。 */
  ev: ThreadEvent;
  /** 是否处于生成中（决定是否播放渐进揭示）。 */
  busy?: boolean;
  /** 打开正文中引用的文件（在右侧面板预览）。 */
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

/**
 * 助手消息卡：渲染正文（生成中渐进揭示）、附件、外链与复制入口。
 * @param props 组件入参
 * @returns 助手消息节点
 */
export function AssistantCard(props: AssistantCardProps): ReactElement {
  const { ev, busy, animate, onOpenFile, onRegenerate, schedule } = props;
  const [shown, setShown] = React.useState<string>('');
  const full = (ev.payload?.content as string) || '';

  // 揭示器跨渲染复用（构造只发生一次，等价原 class 的「生命周期内复用」）。
  const revealerRef = React.useRef<TextRevealer | null>(null);
  if (revealerRef.current === null) {
    revealerRef.current = new TextRevealer((next) => setShown(next), schedule ?? setTimeout);
  }

  // 文本 / busy / animate 任一变化即重启揭示（依赖写全；不比对 prev）。
  React.useEffect(() => {
    revealerRef.current?.start(full, animate !== false && busy === true);
  }, [full, busy, animate]);

  // 卸载即停止揭示（清理对称）。
  React.useEffect(() => () => revealerRef.current?.stop(), []);

  /**
   * 点击正文中的文件链接：拦截跳转，改在右侧面板打开。
   * @param e 点击事件
   */
  const onContentClick = (e: MouseEvent): void => {
    const target = e.target as HTMLElement | null;
    if (!target || !onOpenFile) return;
    const anchor = target.closest('a[data-file-path]') as HTMLElement | null;
    if (anchor) {
      e.preventDefault();
      e.stopPropagation();
      onOpenFile((anchor as unknown as { dataset: { filePath?: string } }).dataset.filePath || '');
    }
  };

  /**
   * 复制正文（失败静默，由 ClipboardCopier fail-closed 兜底）。
   * @param e 点击事件
   */
  const onCopy = (e: MouseEvent): void => {
    e.stopPropagation();
    void ClipboardCopier.copy(full);
  };

  const p = ev.payload || {};
  return (
    <>
      <div className="head">
        {badge(ev.type)}
        <span className="time">{timeOf(ev.timestamp)}</span>
        {onRegenerate ? (
          <button
            className="msg-act"
            title="重新生成"
            aria-label="重新生成"
            onClick={(e: MouseEvent) => {
              e.stopPropagation();
              onRegenerate();
            }}
          >
            ↻ 重新生成
          </button>
        ) : null}
      </div>
      <div className={'card ' + ev.type}>
        <div className="content" spellCheck="false" onClick={onContentClick}>
          {renderMarkdown(shown || full)}
        </div>
        <AttachmentChips files={p.files as FileAttachment[] | undefined} />
        <ExternalLinkCards urls={extractUrls(full)} />
        <button className="copy-btn" title="复制结果" style={COPY_BTN} onClick={onCopy}>
          📋 复制
        </button>
      </div>
    </>
  );
}
