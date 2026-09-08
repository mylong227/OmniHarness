// 中栏：实时事件流 + 工具调用内联结果 + 流式参数占位 + 底部输入框。
// 事件按类型渲染，工具调用卡片聚合 args 与 result；点击任意事件卡触发钻取。
//
// 回合内「过程类」事件（reasoning/tool_call/tool_result）默认按 batch 折叠成单个
// <details>，summary 显示步数与工具分布（write_file×2、bash×5、思考×3…）；
// busy=true 时默认展开便于实时观察，busy=false 时默认收起让对话流聚焦最终结果。
// user / assistant / question / system / todo 等「结果类」始终直显。

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

/**
 * 外部链接卡片（#OBS-11）：assistant 文本里出现的 http(s) URL 提取为可点击列表。
 * 解决"模型产出后给个部署/文档 URL，UI 里淹没在 markdown 里"——让用户一眼能看到。
 * 不做 OG 抓取（需要后端代理 + 缓存 + 隐私边界），纯卡片样式已足以让 URL 不被忽略。
 */
const URL_RE = /\bhttps?:\/\/[^\s<>")'\]]+/g;
function extractUrls(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of text.matchAll(URL_RE)) {
    const u = m[0].replace(/[.,;:!?)]+$/, ''); // 去掉末尾标点
    if (u && !seen.has(u)) {
      seen.add(u);
      out.push(u);
    }
  }
  return out;
}
function ExternalLinkCards(props: { urls: readonly string[] }): ReactElement | null {
  if (props.urls.length === 0) return null;
  return html`<div className="link-cards">
    <div className="link-cards-head">🔗 外部链接 · ${props.urls.length}</div>
    ${props.urls.map(
      (u) =>
        html`<a className="link-card" href=${u} target="_blank" rel="noopener noreferrer" key=${u}>
          <span className="link-card-host">${esc(hostOf(u))}</span>
          <span className="link-card-url">${esc(u)}</span>
        </a>`,
    )}
  </div>`;
}
function hostOf(u: string): string {
  try {
    return new URL(u).host;
  } catch {
    return u;
  }
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
  // #OBS-11：失败时把 error 摘要直接显示在工具行尾部（不折叠），让用户立刻看到
  // 「为什么失败」——之前要展开 details 才能看到 error，沙箱拒绝/路径越界等根因
  // 全被吞了，长会话等半天还在原地打转。
  const errText = res && !res.ok && res.text ? res.text.replace(/^✗\s*/, '') : '';
  // write_file / apply_patch 成功 → 渲染「产物卡片」：文件名 + 工作区相对路径 + 下载链接。
  // 用户不再需要切去文件管理器自己找产物，对应 WorkBuddy artifact 体验。
  const artifact = res && res.ok ? artifactFromTool(p.name as string, p.args) : null;
  return html`<div className="ev tool_call">
    <div className="tc-line" onClick=${() => setOpen((o) => !o)} title=${open ? '收起详情' : '点击查看调用详情'}>
      <span className="tc-chevron">${open ? '▾' : '▸'}</span>
      <span className="tc-icon">🔧</span>
      <span className="tool-name">${esc((p.name as string) || 'tool')}</span>
      ${summary ? html`<span className="tc-summary">${esc(summary)}</span>` : html`<span className="tc-summary"></span>`}
      <span className=${'tool-status ' + status}>${statusText}</span>
      <span className="time">${timeOf(ev.timestamp)}</span>
    </div>
    ${errText ? html`<div className="tc-error" title=${esc(errText)}>⚠ ${esc(truncate(errText, 160))}</div>` : null}
    ${artifact ? html`<${ArtifactCard} info=${artifact} />` : null}
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

/** 截断长字符串到指定字符数（按字形，UTF-16 单元），超长末尾加省略号。 */
function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}

/** 写类工具的产物描述：从 args 提取目标路径。仅返回"可安全下载"的工作区相对路径。 */
interface ArtifactInfo {
  readonly name: string;       // 展示用文件名
  readonly relPath: string;    // 相对工作区的路径（URL 编码后给 /files?path=）
  readonly kind: 'file' | 'patch';
}
function artifactFromTool(name: string, args: unknown): ArtifactInfo | null {
  if (!args || typeof args !== 'object') return null;
  const a = args as Record<string, unknown>;
  if (name === 'write_file' || name === 'apply_patch') {
    const path = typeof a['path'] === 'string' ? a['path'] : '';
    if (!path) return null;
    const fileName = path.split(/[\\/]/).pop() || path;
    return { name: fileName, relPath: path, kind: name === 'apply_patch' ? 'patch' : 'file' };
  }
  return null;
}

/**
 * 产物卡片（#OBS-11）：写类工具成功后展示——文件名 + 工作区路径 + 「下载」按钮直跳 /files。
 * 与 WorkBuddy artifact 卡片体验一致：用户无需切去资源管理器找产物。
 */
function ArtifactCard(props: { info: ArtifactInfo }): ReactElement {
  const { info } = props;
  const href = `/files?path=${encodeURIComponent(info.relPath)}`;
  return html`<div className="artifact-card">
    <span className="artifact-icon">${info.kind === 'patch' ? '🩹' : '📄'}</span>
    <div className="artifact-meta">
      <div className="artifact-name" title=${esc(info.relPath)}>${esc(info.name)}</div>
      <div className="artifact-path">${esc(info.relPath)}</div>
    </div>
    <a className="artifact-download" href=${href} download=${esc(info.name)} title="下载到本地">⬇ 下载</a>
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

/** 回合内过程事件类型：放进 process-cluster 折叠。 */
const PROCESS_TYPES = new Set(['reasoning', 'tool_call', 'tool_result']);

/** 单个事件块（结果类直接展示）。 */
interface SingleBlock {
  readonly kind: 'single';
  readonly event: ThreadEvent;
}

/** 回合内连续过程事件合并块（reasoning/tool_call/tool_result 默认折叠）。 */
interface ProcessBlock {
  readonly kind: 'process';
  readonly events: readonly ThreadEvent[];
  /** 块首 key，React 列表 diff 用。 */
  readonly key: string;
}

type DisplayBlock = SingleBlock | ProcessBlock;

/** 把 events 拆成可视块：busy=true 时单 event 不折叠；busy=false 时把过程类打包成 process 块。
 *  块边界 = 相邻过程事件之间的非过程事件（user/assistant/question/system/...）。
 *  这样一个回合内多次「思考→工具→结果」自然归到一个 details，对话流读起来干净。 */
function buildDisplayBlocks(events: readonly ThreadEvent[], busy: boolean | undefined): DisplayBlock[] {
  if (busy === true) {
    return events.map((e) => ({ kind: 'single', event: e } as SingleBlock));
  }
  const blocks: DisplayBlock[] = [];
  let buf: ThreadEvent[] = [];
  const flush = (): void => {
    if (buf.length === 0) return;
    const first = buf[0]!;
    blocks.push({
      kind: 'process',
      events: buf,
      key: first.id,
    } as ProcessBlock);
    buf = [];
  };
  for (const ev of events) {
    if (PROCESS_TYPES.has(ev.type)) {
      buf.push(ev);
    } else {
      flush();
      blocks.push({ kind: 'single', event: ev } as SingleBlock);
    }
  }
  flush();
  return blocks;
}

/** 过程块 summary 文本：「N 步 · 思考×A · write_file×2 · bash×5」。 */
function processSummary(events: readonly ThreadEvent[]): string {
  let thinkCount = 0;
  const toolCounts = new Map<string, number>();
  let stepCount = 0;
  for (const ev of events) {
    if (ev.type === 'reasoning') {
      thinkCount++;
      stepCount++;
    } else if (ev.type === 'tool_call') {
      stepCount++;
      const name = (ev.payload?.name as string) || 'tool';
      toolCounts.set(name, (toolCounts.get(name) || 0) + 1);
    } else if (ev.type === 'tool_result') {
      stepCount++;
    }
  }
  const parts: string[] = [];
  if (thinkCount > 0) parts.push(`思考×${thinkCount}`);
  // 工具名按调用次数降序、同次数字母序
  const entries = Array.from(toolCounts.entries()).sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  );
  for (const [name, n] of entries) parts.push(`${name}×${n}`);
  return `${stepCount} 步 · ${parts.join(' · ')}`;
}

/** 过程块详情容器：根据忙碌态决定默认 open/closed，summary 显示步数 + 工具分布。 */
function ProcessCluster(props: {
  block: ProcessBlock;
  toolResults: Record<string, ToolResultView>;
  onEventClick: (ev: ThreadEvent) => void;
  busy?: boolean;
  renderEvent: (ev: ThreadEvent) => ReactElement | null;
}): ReactElement {
  const { block, toolResults, onEventClick, busy, renderEvent } = props;
  const text = processSummary(block.events);
  const detailsRef = React.useRef<HTMLDetailsElement | null>(null);
  // #OBS-13：用户手动切换覆盖默认——一旦用户主动 open/close，不再让 busy 推回初始值。
  // 用 ref 标记「用户已接管」，避免依赖引发的 effect 死循环。
  const userToggleRef = React.useRef(false);
  React.useLayoutEffect(() => {
    const d = detailsRef.current;
    if (!d) return;
    if (userToggleRef.current) return; // 用户已接管，不再调整
    const shouldOpen = busy === true;
    if (d.open !== shouldOpen) {
      d.open = shouldOpen;
    }
  }, [busy, block.key]);
  const isOpen = busy === true;
  return html`<details
    className="ev process-cluster"
    ref=${detailsRef}
    key=${block.key}
    open=${isOpen}
    onToggle=${(e: Event) => {
      // 用户主动展开/收起后，置位标志，后续 busy 变化不再覆盖用户意图。
      userToggleRef.current = true;
    }}
  >
    <summary className="tc-line dim" title=${isOpen ? '过程进行中（自动展开）' : '点击查看执行过程'}>
      <span className="tc-chevron-cluster"></span>
      <span className="tc-icon">⏵</span>
      <span className="tc-summary">执行过程 · ${esc(text)}</span>
      <span className="time">${block.events.length} 事件</span>
    </summary>
    <div className="process-cluster-body">
      ${block.events.map((ev) => renderEvent(ev))}
    </div>
  </details>`;
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
   * 把 events 拆成可视块（详见 buildDisplayBlocks）：
   *   busy=true（agent 正在干）→ 每个事件独立成块，照常顺序展示全过程
   *   busy=false（回合结束） → 把相邻的 reasoning / tool_call / tool_result 合并成一个
   *                          <details> 折叠块，summary 显示步数与工具分布；
   *                          用户点开看全量细节，关闭即只看到最终结果
   * 让对话流既能在进行中观察，又能干净聚焦于结果。
   */
  const blocks = React.useMemo(() => buildDisplayBlocks(events, busy), [events, busy]);

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
  }, [blocks, liveInputs]);

  const renderEvent = React.useCallback((ev: ThreadEvent): ReactElement | null => {
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
            <${ExternalLinkCards} urls=${extractUrls((p.content as string) || '')} />
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
  }, [toolCallIds, onEventClick, onOpenFile, toolResults]);

  return html`<div className="col center">
    <div className="stream" ref=${streamRef}>
      ${events.length === 0 && liveInputs.length === 0
        ? emptyState('💬', '等待任务', '下达任务后，模型推理、工具调用与结果将在此实时呈现。')
        : html`<div className="stream-inner">
            ${blocks.map((b) =>
              b.kind === 'process'
                ? html`<${ProcessCluster}
                    key=${b.key}
                    block=${b}
                    toolResults=${toolResults}
                    onEventClick=${onEventClick}
                    busy=${busy}
                    renderEvent=${renderEvent}
                  />`
                : renderEvent(b.event),
            )}
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
