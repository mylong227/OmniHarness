// 中栏：实时事件流 + 工具调用内联结果 + 流式参数占位 + 底部输入框。
//
// 事件按类型渲染，工具调用卡片聚合 args 与 result；点击任意事件卡触发钻取。
// 回合内「过程类」事件（reasoning/tool_call/tool_result）默认折叠成 <details>，
// summary 显示步数与工具分布；busy 时展开便于观察，结束后收起聚焦结果。
//
// 面向对象改造：子组件各自成文件（ToolCallCard / ReasoningBlock / ProcessCluster /
// AssistantCard / ArtifactCard / AttachmentChips / ExternalLinkCards），
// 本组件只负责「事件 → 可视块」的分派与滚动锚定。
//
// 函数组件范式：无内部 state（lastUserId/lastAssistantId 改渲染期局部量，不再写实例字段）；
// 滚动锚定由依赖 [events, liveInputs] 的 effect 承接（兼作挂载即滚动）；
// 事件 / 流式行的渲染分派下沉为模块级纯函数（避免组件体膨胀）。

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
import { UserCard } from './stream/UserCard.js';
import { StreamingAssistantCard } from './stream/StreamingAssistantCard.js';
import type { ThreadEvent, FileAttachment } from '../../types/models.js';
import type { ComposerSeed, LiveInput } from '../shared.js';
import type { ApiClient } from '../../core/ApiClient.js';
import type { ToolResultView } from '../shared.js';

/** 兼容旧引用路径：本类型已下沉到 shared，此处保留再导出。 */
export type { ToolResultView };

/** StreamView 组件的入参。 */
export interface StreamViewProps {
  events: ThreadEvent[];
  toolResults: Record<string, ToolResultView>;
  liveInputs: LiveInput[];
  /** 本回合已累积的流式正文（`thread.text_delta` 增量拼接）。非空即在末尾渲染生成中的助手卡片。 */
  streamText?: string;
  /** 已被 assistant 事件收口的流式文本（用于免掉最终卡片的重复揭示动画）。 */
  finalizedStreamText?: string;
  /** 输入框回填指令（F4「编辑重发」）：透传给 Composer，把末条用户消息填回输入框。 */
  composerSeed?: ComposerSeed | null;
  onEventClick: (ev: ThreadEvent) => void;
  /** 点击助手回复中的文件路径链接时，在右侧文件面板打开（而不是跳外链）。 */
  onOpenFile?: (path: string) => void;
  onSend: (
    prompt: string,
    images: { url?: string; data?: string; mediaType?: string }[],
    files: FileAttachment[],
  ) => void;
  /** 停止在跑回合（busy 时由 Composer 停止按钮触发）。 */
  onStop?: () => void;
  /** 重新生成（最后一条助手消息挂载）。 */
  onRegenerate?: () => void;
  /** 编辑重发（最后一条用户消息挂载）：把该消息填回底部输入框。 */
  onEditUser?: () => void;
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

/** 单事件渲染所需的上下文（从 props 收拢，供模块级分派函数复用）。 */
interface EventCtx {
  toolResults: Record<string, ToolResultView>;
  onEventClick: (ev: ThreadEvent) => void;
  onOpenFile?: (path: string) => void;
  busy?: boolean;
  /** 最后一条用户消息 id（仅它可编辑重发）。 */
  lastUserId: string;
  /** 最后一条助手消息 id（仅它可重新生成）。 */
  lastAssistantId: string;
  onEditUser?: () => void;
  onRegenerate?: () => void;
  /** 已被 assistant 事件收口的流式文本。 */
  finalizedStreamText: string;
  /** 本回合出现过的工具调用 id。 */
  toolCallIds: Set<string>;
}

/**
 * 判断一条 assistant 事件的内容是否正是本轮已被流式渲染过的文本。
 *
 * 命中时跳过最终卡片的渐进揭示动画，避免「逐字已显示完 → 归入正式卡片时又从零重播」的视觉回跳。
 * @param p 事件载荷（含 content）
 * @param finalized 已收口的流式文本
 * @returns 已流过则 true
 */
function wasStreamed(p: Record<string, unknown>, finalized: string): boolean {
  if (finalized === '') return false;
  return ((p.content as string) || '') === finalized;
}

/**
 * 单事件渲染分派。返回 null 表示该类型不在对话流中展示（如 session_meta / model）。
 * @param ev 事件
 * @param ctx 渲染上下文
 * @returns 事件节点；不展示时为 null
 */
function renderEventNode(ev: ThreadEvent, ctx: EventCtx): ReactElement | null {
  const p = ev.payload || {};
  const node = (inner: ReactElement): ReactElement => (
    <div className={'ev clickable ' + ev.type} key={ev.id} onClick={() => ctx.onEventClick(ev)}>
      {inner}
    </div>
  );

  switch (ev.type) {
    case 'user':
      return node(
        <UserCard
          ev={ev}
          busy={ctx.busy}
          canEdit={ev.id === ctx.lastUserId}
          onEdit={() => ctx.onEditUser?.()}
        />,
      );
    case 'assistant':
      return node(
        <AssistantCard
          ev={ev}
          busy={ctx.busy}
          onOpenFile={ctx.onOpenFile}
          animate={!wasStreamed(p, ctx.finalizedStreamText)}
          onRegenerate={ev.id === ctx.lastAssistantId && ctx.busy !== true ? ctx.onRegenerate : undefined}
        />,
      );
    case 'reasoning':
      return <ReasoningBlock key={ev.id} ev={ev} />;
    case 'tool_call':
      return (
        <ToolCallCard
          key={ev.id}
          ev={ev}
          res={ctx.toolResults[(p.callId as string) || ev.id]}
          onEventClick={ctx.onEventClick}
          onOpenFile={ctx.onOpenFile}
        />
      );
    case 'tool_result':
      // 已被调用卡内联的结果不再单独渲染；孤儿结果（调用被历史截断）折叠成一行。
      if (ctx.toolCallIds.has((p.callId as string) || '')) return null;
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
          {todoView((p.todos as Parameters<typeof todoView>[0]) || [])}
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

/**
 * 流式参数占位行：尽力解析 partial JSON 提取人话动作，失败则用缺参兜底描述。
 * @param li 流式输入
 * @returns 占位行节点
 */
function renderLiveInputRow(li: LiveInput): ReactElement {
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
        <span className="tc-summary tc-action">{esc(describeToolCall(li.name, partialArgs))}</span>
        <span className="tool-status pending">进行中…</span>
      </div>
    </div>
  );
}

/**
 * 渲染单个可视块：过程簇或单事件。
 * @param b 可视块
 * @param ctx 渲染上下文
 * @returns 块节点
 */
function renderBlockNode(b: ReturnType<typeof buildDisplayBlocks>[number], ctx: EventCtx): ReactElement | null {
  if (b.kind === 'process') {
    return (
      <ProcessCluster
        key={b.key}
        block={b}
        onEventClick={ctx.onEventClick}
        busy={ctx.busy}
        renderEvent={(ev) => renderEventNode(ev, ctx)}
      />
    );
  }
  return renderEventNode(b.event, ctx);
}

/**
 * 事件流组件：渲染事件块、流式占位与底部输入区，并锚定滚动到底部。
 * @param props 组件入参
 * @returns 中栏节点
 */
export function StreamView(props: StreamViewProps): ReactElement {
  const {
    events,
    toolResults,
    liveInputs,
    streamText,
    finalizedStreamText,
    composerSeed,
    onEventClick,
    onOpenFile,
    onSend,
    onStop,
    onRegenerate,
    onEditUser,
    model,
    modelOptions,
    providerLabel,
    reasoning,
    permission,
    threadId,
    onToast,
    onOpenTab,
    onLoadThread,
    busy,
    activeTool,
    api,
    onModelChange,
    onReasoningChange,
    onPermissionChange,
    disabled,
  } = props;
  const streamRef = React.useRef<HTMLDivElement | null>(null);

  // 新事件 / 流式输入到达后锚定到底部（长会话里用户不必手动追）；兼作挂载即滚动。
  React.useEffect(() => {
    const el = streamRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [events, liveInputs]);

  // 仅最后一条用户 / 助手消息提供编辑 / 重新生成入口。
  let lastUserId = '';
  let lastAssistantId = '';
  for (const e of events) {
    if (e.type === 'user') lastUserId = e.id;
    else if (e.type === 'assistant') lastAssistantId = e.id;
  }
  /** 本回合内出现过的工具调用 id：用于判断 tool_result 是否已被调用卡内联。 */
  const toolCallIds = new Set<string>();
  for (const e of events) {
    if (e.type === 'tool_call') {
      const p = e.payload || {};
      toolCallIds.add((p.callId as string) || e.id);
    }
  }
  const ctx: EventCtx = {
    toolResults,
    onEventClick,
    onOpenFile,
    busy,
    lastUserId,
    lastAssistantId,
    onEditUser,
    onRegenerate,
    finalizedStreamText: finalizedStreamText ?? '',
    toolCallIds,
  };
  const blocks = buildDisplayBlocks(events, busy);
  const streaming = streamText ?? '';
  return (
    <div className="col center">
      <div
        className="stream"
        role="log"
        aria-live="polite"
        aria-relevant="additions"
        aria-label="对话事件流"
        ref={streamRef}
      >
        {events.length === 0 && liveInputs.length === 0 && streaming === '' ? (
          emptyState('💬', '等待任务', '下达任务后，模型推理、工具调用与结果将在此实时呈现。')
        ) : (
          <div className="stream-inner">
            {blocks.map((b) => renderBlockNode(b, ctx))}
            {liveInputs.map((li) => renderLiveInputRow(li))}
            {streaming !== '' ? <StreamingAssistantCard key="streaming-assistant" text={streaming} /> : null}
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
        seed={composerSeed ?? null}
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
        onStop={onStop}
      />
    </div>
  );
}
