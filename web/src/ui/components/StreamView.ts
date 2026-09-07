// 中栏：实时事件流 + 工具调用内联结果 + 流式参数占位 + 底部输入框。
// 事件按类型渲染，工具调用卡片聚合 args 与 result；点击任意事件卡触发钻取。

import { html, React } from '../deps.js';
import { badge, jsonView, todoView, diffView, timeOf, emptyState, esc, renderMarkdown, questionView } from '../format.js';
import type { ThreadEvent, FileAttachment } from '../../types/models.js';
import type { LiveInput } from '../shared.js';
import type { ApiClient } from '../../core/ApiClient.js';
import { Composer } from './Composer.js';

/** 复制文本到剪贴板（失败静默，不阻断 UI）。 */
function copyText(text: string): Promise<void> {
  try {
    return navigator.clipboard.writeText(text);
  } catch {
    return Promise.resolve();
  }
}

export interface ToolResultView {
  text: string;
  ok: boolean;
}

/** 用户/助手消息携带的附件（#B5）：以 chip 形式内联展示。 */
function attachmentChips(files?: FileAttachment[]): ReactElement | null {
  if (!files || files.length === 0) return null;
  return html`<div className="ev-attachments">
    ${files.map(
      (f) =>
        html`<span className="ev-chip" key=${f.name + (f.data ?? f.url ?? '').slice(0, 10)}>
          <span className="ev-chip-ico"
            >${f.mediaType.startsWith('image/') ? '🖼' : f.mediaType.startsWith('video/') ? '🎬' : '📎'}</span
          >
          <span className="ev-chip-name">${esc(f.name)}</span>
        </span>`,
    )}
  </div>`;
}

/** 从工具参数里抽一行可读摘要（首个标量值），超长截断——详情点开才看全量。 */
function argSummary(args: unknown): string {  if (args === null || args === undefined || typeof args !== 'object') return '';
  const parts: string[] = [];
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      parts.push(`${k}=${v}`);
    }
    if (parts.length >= 2) break;
  }
  const s = parts.join(' · ');
  return s.length > 56 ? s.slice(0, 56) + '…' : s;
}

/** 工具调用行：默认只显示「调了什么 + 参数摘要 + 状态」，点击展开 args 与结果详情。 */
function ToolCallCard(props: { ev: ThreadEvent; res?: ToolResultView; onEventClick: (ev: ThreadEvent) => void }): ReactElement {
  const { ev, res, onEventClick } = props;
  const p = ev.payload || {};
  const [open, setOpen] = React.useState(false);
  const status = res ? (res.ok ? 'ok' : 'err') : 'pending';
  const statusText = res ? (res.ok ? '成功' : '失败') : '运行中…';
  const summary = argSummary(p.args);
  return html`<div className="ev tool_call">
    <div className="tc-line" onClick=${() => setOpen((o) => !o)} title=${open ? '收起详情' : '点击查看调用详情'}>
      <span className="tc-chevron">${open ? '▾' : '▸'}</span>
      <span className="tc-icon">🔧</span>
      <span className="tool-name">${esc((p.name as string) || 'tool')}</span>
      ${summary ? html`<span className="tc-summary">${esc(summary)}</span>` : html`<span className="tc-summary"></span>`}
      <span className=${'tool-status ' + status}>${statusText}</span>
      <span className="time">${timeOf(ev.timestamp)}</span>
    </div>
    ${open
      ? html`<div className="tc-detail">
          ${p.args ? jsonView(p.args) : null}
          <div className="tool-result">
            ${res
              ? html`<div className="tool-output">${esc(res.text)}</div>`
              : html`<div className="tool-output tc-waiting">等待结果…</div>`}
          </div>
          <button
            className="tc-drill"
            title="在右侧钻取面板查看原始事件"
            onClick=${(e: MouseEvent) => {
              e.stopPropagation();
              onEventClick(ev);
            }}
          >⤢ 在钻取面板查看</button>
        </div>`
      : null}
  </div>`;
}

/** 思考过程行：默认折叠为一行「💭 思考过程」，点开看全文——thinking 有提示但不刷屏。 */
function ReasoningBlock(props: { ev: ThreadEvent }): ReactElement {
  const p = props.ev.payload || {};
  const [open, setOpen] = React.useState(false);
  const content = (p.content as string) || '';
  return html`<div className="ev reasoning">
    <div className="tc-line dim" onClick=${() => setOpen((o) => !o)} title=${open ? '收起' : '点击查看思考内容'}>
      <span className="tc-chevron">${open ? '▾' : '▸'}</span>
      <span className="tc-icon">💭</span>
      <span className="tc-summary">思考过程 · ${content.length} 字</span>
    </div>
    ${open ? html`<div className="tc-detail"><div className="reason-body" spellCheck="false">${esc(content)}</div></div>` : null}
  </div>`;
}

export interface StreamViewProps {
  events: ThreadEvent[];
  toolResults: Record<string, ToolResultView>;
  liveInputs: LiveInput[];
  onEventClick: (ev: ThreadEvent) => void;
  /** 点击助手回复中的文件路径链接时，在右侧文件面板打开（而不是跳外链）。 */
  onOpenFile?: (path: string) => void;
  onSend: (
    prompt: string,
    images: { url?: string; data?: string; mediaType?: string }[],
    files: FileAttachment[],
  ) => void;
  /** 当前配置（驱动 Composer 的三个切换器）。 */
  model: string;
  /** 当前厂商可用模型清单（缺省时 Composer 用内置兜底）。 */
  modelOptions?: string[];
  /** 当前厂商展示名（模型下拉标题用）。 */
  providerLabel?: string;
  reasoning: string;
  permission: string;
  /** 回合进行中（agent 正在干活）——为真时显示思考/工具过程，结束后隐藏只留结果。 */
  busy?: boolean;
  /** 当前正在调用的工具名（无则显示"思考中"），透传给 Composer 状态条。 */
  activeTool?: string | null;
  /** ApiClient（给 Composer 附件 FilePicker 走 attach.read 用）。 */
  api: ApiClient;
  onModelChange: (v: string) => void;
  onReasoningChange: (v: string) => void;
  onPermissionChange: (v: string) => void;
  disabled?: boolean;
}

export function StreamView(props: StreamViewProps): ReactElement {
  const {
    events,
    toolResults,
    liveInputs,
    onEventClick,
    onOpenFile,
    onSend,
    model,
    modelOptions,
    providerLabel,
    reasoning,
    permission,
    busy,
    activeTool,
    api,
    onModelChange,
    onReasoningChange,
    onPermissionChange,
    disabled,
  } = props;
  const streamRef = React.useRef<HTMLDivElement | null>(null);

  /**
   * 会话结束后（busy=false）隐藏思考过程与工具调用/结果事件，只保留用户提问与助手最终回复，
   * 让对话流干净聚焦于「结果」。回合进行中（busy=true）照常展示全过程，便于实时观察。
   */
  const HIDDEN_WHEN_IDLE = React.useMemo(
    () => new Set(['reasoning', 'tool_call', 'tool_result']),
    [],
  );
  const displayEvents = React.useMemo(() => {
    if (busy === true) return events;
    return events.filter((e) => !HIDDEN_WHEN_IDLE.has(e.type));
  }, [events, busy, HIDDEN_WHEN_IDLE]);

  const toolCallIds = React.useMemo(() => {
    const s = new Set<string>();
    for (const e of events) {
      if (e.type === 'tool_call') {
        const p = e.payload || {};
        const id = (p.callId as string) || e.id;
        s.add(id);
      }
    }
    return s;
  }, [events]);

  React.useEffect(() => {
    const el = streamRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [displayEvents, liveInputs]);

  function renderEvent(ev: ThreadEvent): ReactElement | null {
    const p = ev.payload || {};
    const node = (inner: ReactElement) =>
      html`<div className=${'ev clickable ' + ev.type} key=${ev.id} onClick=${() => onEventClick(ev)}>${inner}</div>`;

  switch (ev.type) {
      case 'user':
        return node(
          html`<div className="head">${badge(ev.type)}<span className="time">${timeOf(ev.timestamp)}</span></div>
          <div className=${'card ' + ev.type}>
            <div className="content" spellCheck="false">${esc((p.content as string) || '')}</div>
            ${attachmentChips(p.files as FileAttachment[] | undefined)}
          </div>`,
        );
      case 'assistant':
        return node(
          html`          <div className="head">
            ${badge(ev.type)}<span className="time">${timeOf(ev.timestamp)}</span>
          </div>
          <div className=${'card ' + ev.type}>
            <div
              className="content"
              spellCheck="false"
              onClick=${(e: MouseEvent) => {
                const target = e.target as HTMLElement | null;
                if (!target || !onOpenFile) return;
                const anchor = target.closest('a[data-file-path]') as HTMLElement | null;
                if (anchor) {
                  e.preventDefault();
                  e.stopPropagation();
                  onOpenFile(anchor.dataset.filePath || '');
                }
              }}
            >${renderMarkdown((p.content as string) || '')}</div>
            ${attachmentChips(p.files as FileAttachment[] | undefined)}
            <button
              className="copy-btn"
              title="复制结果"
              style=${{ marginTop: '10px', background: 'transparent', border: '1px solid var(--border)', borderRadius: '6px', padding: '3px 10px', cursor: 'pointer', color: 'inherit', fontSize: '11px', alignSelf: 'flex-start' }}
              onClick=${(e: MouseEvent) => {
                e.stopPropagation();
                void copyText((p.content as string) || '');
              }}
            >📋 复制</button>
          </div>`,
        );
      case 'reasoning':
        return html`<${ReasoningBlock} key=${ev.id} ev=${ev} />`;
      case 'tool_call':
        return html`<${ToolCallCard}
          key=${ev.id}
          ev=${ev}
          res=${toolResults[(p.callId as string) || ev.id]}
          onEventClick=${onEventClick}
        />`;
      case 'tool_result':
        if (toolCallIds.has((p.callId as string) || '')) return null;
        // 孤儿结果（对应调用不在流里，如历史截断）：同样折叠成一行。
        return html`<details className="ev tool_result standalone" key=${ev.id}>
          <summary className="tc-line dim">
            <span className="tc-chevron">▸</span><span className="tc-icon">↳</span>
            <span className="tc-summary">工具结果（独立事件）</span>
          </summary>
          <div className="tc-detail"><div className="tool-output">${esc(JSON.stringify(p))}</div></div>
        </details>`;
      case 'system':
        return node(html`<div className="sysnote" spellCheck="false">— ${esc((p.content as string) || '')} —</div>`);
      case 'todo':
        return node(html`<div className="head">${badge('todo')}</div>${todoView((p.todos as any) || [])}`);
      case 'plan':
        return node(html`<div className="head">${badge('plan')}</div><div className="card">${jsonView(p)}</div>`);
      case 'question':
        return node(
          html`<div className="head">${badge('question')}</div><div className="card">${questionView((p.questions as any) || p)}</div>`,
        );
      case 'turn_diff':
        return node(html`<div className="head">${badge('turn_diff')}</div><div className="diff">${diffView((p.diff as string) || '')}</div>`);
      case 'session_meta':
        // 会话元数据（工作区标记）：仅供会话收纳，不在对话流里渲染。
        return null;
      case 'model':
        // 模型用量事件：token 统计在「指标」面板看，对话流里渲染只会是一坨 JSON。
        return null;
      default:
        return node(
          html`<div className="head">${badge(ev.type)}</div><div className="card"><div className="content" spellCheck="false">${esc(JSON.stringify(p))}</div></div>`,
        );
    }
  }

  return html`<div className="col center">
    <div className="stream" ref=${streamRef}>
      ${events.length === 0 && liveInputs.length === 0
        ? emptyState('💬', '等待任务', '下达任务后，模型推理、工具调用与结果将在此实时呈现。')
        : html`<div className="stream-inner">
            ${displayEvents.map((e) => renderEvent(e))}
            ${liveInputs.map(
              (li) =>
                html`<div className="ev" key=${li.id}>
                  <div className="tc-line">
                    <span className="tc-chevron">▸</span><span className="tc-icon">🔧</span>
                    <span className="tool-name">${esc(li.name)}</span>
                    <span className="tc-summary">${esc(li.partial.slice(0, 56))}</span>
                    <span className="tool-status pending">参数生成中…</span>
                  </div>
                </div>`,
            )}
          </div>`}
    </div>
    <${Composer}
      model=${model}
      modelOptions=${modelOptions}
      providerLabel=${providerLabel}
      reasoning=${reasoning}
      permission=${permission}
      onModelChange=${onModelChange}
      onReasoningChange=${onReasoningChange}
      onPermissionChange=${onPermissionChange}
      onSend=${onSend}
      disabled=${disabled}
      busy=${busy}
      activeTool=${activeTool}
      api=${api}
    />
  </div>`;
}
