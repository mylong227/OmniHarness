// 中栏：实时事件流 + 工具调用内联结果 + 流式参数占位 + 底部输入框。
//
// 事件按类型渲染，工具调用卡片聚合 args 与 result；点击任意事件卡触发钻取。
// 回合内「过程类」事件（reasoning/tool_call/tool_result）默认折叠成 <details>，
// summary 显示步数与工具分布；busy 时展开便于观察，结束后收起聚焦结果。
//
// 面向对象改造：子组件各自成类（ToolCallCard / ReasoningBlock / ProcessCluster /
// AssistantCard / ArtifactCard / AttachmentChips / ExternalLinkCards），
// 本组件只负责「事件 → 可视块」的分派与滚动锚定。

import { React } from '../deps.js';
import {
  badge,
  jsonView,
  todoView,
  diffView,
  timeOf,
  emptyState,
  esc,
  questionView,
} from '../format.js';
import { buildDisplayBlocks, describeToolCall } from '../textUtils.js';
import { Composer } from './Composer.js';
import { ToolCallCard } from './stream/ToolCallCard.js';
import { ReasoningBlock } from './stream/ReasoningBlock.js';
import { ProcessCluster } from './stream/ProcessCluster.js';
import { AssistantCard } from './stream/AssistantCard.js';
import type { ThreadEvent, FileAttachment } from '../../types/models.js';
import type { LiveInput } from '../shared.js';
import type { ApiClient } from '../../core/ApiClient.js';
import type { ToolResultView } from '../shared.js';

/** 兼容旧引用路径：本类型已下沉到 shared，此处保留再导出。 */
export type { ToolResultView };

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
  /** 当前模型（驱动 Composer 的切换器）。 */
  model: string;
  /** 当前厂商可用模型清单（缺省时 Composer 用内置兜底）。 */
  modelOptions?: string[];
  /** 当前厂商展示名（模型下拉标题用）。 */
  providerLabel?: string;
  reasoning: string;
  permission: string;
  /** 当前会话 id（AddMenu / 上下文容量面板维度）。 */
  threadId?: string | null;
  /** 轻提示（AddMenu / 容量面板加载失败等）。 */
  onToast?: (msg: string, kind?: 'info' | 'err') => void;
  /** 跳到右侧某面板（AddMenu 点插件时打开「插件」页）。 */
  onOpenTab?: (key: string) => void;
  /** 加载历史会话（AddMenu 搜索命中为聊天时）。 */
  onLoadThread?: (id: string) => void;
  /** 回合进行中——为真时显示思考/工具过程，结束后隐藏只留结果。 */
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

/** 事件流组件。 */
export class StreamView extends React.Component<StreamViewProps> {
  private streamRef: HTMLDivElement | null = null;

  override componentDidMount(): void {
    this.scrollToEnd();
  }

  override componentDidUpdate(prevProps: StreamViewProps): void {
    if (prevProps.events !== this.props.events || prevProps.liveInputs !== this.props.liveInputs) {
      this.scrollToEnd();
    }
  }

  /** 新事件到达后锚定到底部（长会话里用户不必手动追）。 */
  private scrollToEnd(): void {
    const el = this.streamRef;
    if (el) el.scrollTop = el.scrollHeight;
  }

  /** 本回合内出现过的工具调用 id：用于判断 tool_result 是否已被调用卡内联。 */
  private toolCallIds(): Set<string> {
    const s = new Set<string>();
    for (const e of this.props.events) {
      if (e.type === 'tool_call') {
        const p = e.payload || {};
        s.add((p.callId as string) || e.id);
      }
    }
    return s;
  }

  /** 单事件渲染分派。返回 null 表示该类型不在对话流中展示（如 session_meta / model）。 */
  private renderEvent(ev: ThreadEvent, toolCallIds: Set<string>): ReactElement | null {
    const { toolResults, onEventClick, onOpenFile, busy } = this.props;
    const p = ev.payload || {};
    const node = (inner: ReactElement): ReactElement => (
      <div
        className={'ev clickable ' + ev.type}
        key={ev.id}
        onClick={() => onEventClick(ev)}
      >
        {inner}
      </div>
    );

    switch (ev.type) {
      case 'user':
        return node(
          <>
            <div className="head">
              {badge(ev.type)}
              <span className="time">{timeOf(ev.timestamp)}</span>
            </div>
            <div className={'card ' + ev.type}>
              <div className="content" spellCheck="false">
                {esc((p.content as string) || '')}
              </div>
            </div>
          </>,
        );
      case 'assistant':
        return node(<AssistantCard ev={ev} busy={busy} onOpenFile={onOpenFile} />);
      case 'reasoning':
        return <ReasoningBlock key={ev.id} ev={ev} />;
      case 'tool_call':
        return (
          <ToolCallCard
            key={ev.id}
            ev={ev}
            res={toolResults[(p.callId as string) || ev.id]}
            onEventClick={onEventClick}
            onOpenFile={onOpenFile}
          />
        );
      case 'tool_result':
        // 已被调用卡内联的结果不再单独渲染；孤儿结果（调用被历史截断）折叠成一行。
        if (toolCallIds.has((p.callId as string) || '')) return null;
        return (
          <details className="ev tool_result standalone" key={ev.id}>
            <summary className="tc-line dim">
              <span className="tc-chevron">▸</span>
              <span className="tc-icon">↳</span>
              <span className="tc-summary">工具结果（独立事件）</span>
            </summary>
            <div className="tc-detail">
              <div className="tool-output">{esc(JSON.stringify(p))}</div>
            </div>
          </details>
        );
      case 'system':
        return node(
          <div className="sysnote" spellCheck="false">
            — {esc((p.content as string) || '')} —
          </div>,
        );
      case 'todo':
        return node(
          <>
            <div className="head">{badge('todo')}</div>
            {todoView(((p.todos as Parameters<typeof todoView>[0]) || []))}
          </>,
        );
      case 'plan':
        return node(
          <>
            <div className="head">{badge('plan')}</div>
            <div className="card">{jsonView(p)}</div>
          </>,
        );
      case 'question':
        return node(
          <>
            <div className="head">{badge('question')}</div>
            <div className="card">{questionView((p.questions as unknown) || p)}</div>
          </>,
        );
      case 'turn_diff':
        return node(
          <>
            <div className="head">{badge('turn_diff')}</div>
            <div className="diff">{diffView((p.diff as string) || '')}</div>
          </>,
        );
      case 'session_meta':
        // 会话元数据（工作区标记）：仅供会话收纳，不在对话流里渲染。
        return null;
      case 'model':
        // 模型用量事件：token 统计在「指标」面板看，对话流里渲染只会是一坨 JSON。
        return null;
      default:
        return node(
          <>
            <div className="head">{badge(ev.type)}</div>
            <div className="card">
              <div className="content" spellCheck="false">
                {esc(JSON.stringify(p))}
              </div>
            </div>
          </>,
        );
    }
  }

  /** 流式参数占位行：尽力解析 partial JSON 提取人话动作，失败则用缺参兜底描述。 */
  private renderLiveInput(li: LiveInput): ReactElement {
    let partialArgs: unknown = {};
    try {
      partialArgs = JSON.parse(li.partial);
    } catch {
      partialArgs = {};
    }
    return (
      <div className="ev" key={li.id}>
        <div className="tc-line">
          <span className="tc-chevron">▸</span>
          <span className="tc-icon">🔧</span>
          <span className="tc-summary tc-action">
            {esc(describeToolCall(li.name, partialArgs))}
          </span>
          <span className="tool-status pending">进行中…</span>
        </div>
      </div>
    );
  }

  private renderBlock(
    b: ReturnType<typeof buildDisplayBlocks>[number],
    toolCallIds: Set<string>,
  ): ReactElement | null {
    const { toolResults, onEventClick, busy } = this.props;
    if (b.kind === 'process') {
      return (
        <ProcessCluster
          key={b.key}
          block={b}
          onEventClick={onEventClick}
          busy={busy}
          renderEvent={(ev) => this.renderEvent(ev, toolCallIds)}
        />
      );
    }
    return this.renderEvent(b.event, toolCallIds);
  }

  override render(): ReactElement {
    const {
      events,
      toolResults,
      liveInputs,
      onSend,
      model,
      modelOptions,
      providerLabel,
      reasoning,
      permission,
      threadId,
      onToast,
      onOpenTab,
      onOpenFile,
      onLoadThread,
      onModelChange,
      onReasoningChange,
      onPermissionChange,
      disabled,
      busy,
      activeTool,
      api,
    } = this.props;
    const blocks = buildDisplayBlocks(events, busy);
    const ids = this.toolCallIds();
    return (
      <div className="col center">
        <div
          className="stream"
          ref={(el: HTMLDivElement | null) => {
            this.streamRef = el;
          }}
        >
          {events.length === 0 && liveInputs.length === 0 ? (
            emptyState('💬', '等待任务', '下达任务后，模型推理、工具调用与结果将在此实时呈现。')
          ) : (
            <div className="stream-inner">
              {blocks.map((b) => this.renderBlock(b, ids))}
              {liveInputs.map((li) => this.renderLiveInput(li))}
            </div>
          )}
        </div>
        <Composer
          model={model}
          modelOptions={modelOptions}
          providerLabel={providerLabel}
          reasoning={reasoning}
          permission={permission}
          threadId={threadId}
          onToast={onToast}
          onOpenTab={onOpenTab}
          onOpenFile={onOpenFile}
          onLoadThread={onLoadThread}
          onModelChange={onModelChange}
          onReasoningChange={onReasoningChange}
          onPermissionChange={onPermissionChange}
          onSend={onSend}
          disabled={disabled}
          busy={busy}
          activeTool={activeTool}
          api={api}
        />
      </div>
    );
  }
}
