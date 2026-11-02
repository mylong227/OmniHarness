// 中栏：实时事件流 + 工具调用内联结果 + 流式参数占位 + 底部输入框。
//
// 事件按类型渲染，工具调用卡片聚合 args 与 result；点击任意事件卡触发钻取。
// 回合内「过程类」事件（reasoning/tool_call/tool_result）默认折叠成 <details>，
// summary 显示步数与工具分布；busy 时展开便于观察，结束后收起聚焦结果。
//
// 组件分层（2026-11-02 S2 长函数清偿；原 `StreamView` 体 437 行）：
//   · 本文件：props 契约 + 事件分派（renderEventNode / renderBlockNode）+ 滚动锚定接线；
//   · `stream/StreamFeed`：`.stream` 滚动容器、虚拟窗口内的块铺排、空态；
//   · `stream/StreamBottom` / `stream/StreamStatusBar`：输入区挂件与状态栏；
//   · `stream/StreamLiveRow`：流式参数占位行；
//   · `stream/useSessionClock` / `stream/useStreamModel`：时钟与渲染模型（缓存单例）。
//
// **为什么滚动锚定（useStreamScroll / useBlockMeasurements）仍留在本文件**：
// `web/test/streamThreadSwitch.test.ts` 与 `web/test/streamWindowAnchor.test.ts` 是**源码级
// 接线守卫**，它们直接读本文件文本，钉住「切会话复位 stickyRef/scrollTop/holeBoost」「空洞修复
// 只加渲不写回 scrollTop」这两条契约。这两段逻辑一搬走，守卫就失去观测点（会假红），
// 故在本文件内拆成两个模块级 hook，而不是下沉到独立文件。
//
// 函数组件范式：无实例字段（lastUserId/lastAssistantId 来自缓存模型，渲染期局部量）；
// 滚动锚定由依赖 [events, liveInputs, streamText] 的 effect 承接（兼作挂载即滚动）；
// 事件 / 流式行的渲染分派为模块级纯函数（避免组件体膨胀）。
//
// 长会话虚拟化（StreamWindow）：只渲染可视窗口 + 上下 overscan 的块，未渲染区域用占位高度顶上，
// 于是 DOM 节点数与总条数**不成正比**（数百条会话依旧只挂几十个块节点）。
// 贴底策略：只在「此前处于底部」时才把新事件拉到屏内；用户上滚后一律保持 scrollTop 不变。
// 可断言信号：根节点 data-virtual / data-rendered-count / data-total-count / data-event-count。

import * as React from 'react';
import { ChatHeader } from './ChatHeader.tsx';
import type { ChatViewKind } from './ChatHeader.tsx';
import { TraceView } from './TraceView.tsx';
import type { DisplayBlock } from '../textUtils.ts';
import { DEFAULT_ITEM_HEIGHT, StreamWindow } from '../models/StreamWindow.ts';
import type { StreamWindowMetrics } from '../models/StreamWindow.ts';
import { BlockHeightIndex } from '../models/BlockHeightIndex.ts';
import type { StreamModel } from '../models/StreamModelCache.ts';
import { ToolCallCard } from './stream/ToolCallCard.tsx';
import { ReasoningStep, ThinkingTrail } from './stream/ThinkingTrail.tsx';
import { AssistantCard } from './stream/AssistantCard.tsx';
import { UserCard } from './stream/UserCard.tsx';
import { TurnSummaryCard } from './stream/TurnSummaryCard.tsx';
import { StreamFeed } from './stream/StreamFeed.tsx';
import { StreamBottom } from './stream/StreamBottom.tsx';
import { StreamStatusBar } from './stream/StreamStatusBar.tsx';
import { useSessionClock } from './stream/useSessionClock.ts';
import { useStreamModel } from './stream/useStreamModel.ts';
import type { ThreadEvent, FileAttachment, QuestionRequest, QuestionAnswerSubmission, GraphRunState } from '../../types/models.ts';
import type { ComposerSeed, LiveInput } from '../shared.ts';
import type { ChatQueueView } from '../models/ChatMessageQueue.ts';
import type { ApiClient } from '../../core/ApiClient.ts';
import type { ToolResultView } from '../shared.ts';
import {
  renderPlanNode,
  renderQuestionNode,
  renderStandaloneToolResult,
  renderSystemNode,
  renderTodoNode,
  renderUnknownNode,
  type EventCtx,
} from './stream/EventNodeRenderers.tsx';

/** 兼容旧引用路径：本类型已下沉到 shared，此处保留再导出。 */
export type { ToolResultView };

/** StreamView 组件的入参。 */
export interface StreamViewProps {
  events: ThreadEvent[];
  /** 是否还有更早历史可补拉（分页）。 */
  historyHasMore?: boolean;
  /** 正在补拉更早历史。 */
  historyLoading?: boolean;
  /** 补拉更早历史（顶部按钮）。 */
  onLoadEarlier?: () => void;
  toolResults: Record<string, ToolResultView>;
  liveInputs: LiveInput[];
  /** 本回合已累积的流式正文（`thread.text_delta` 增量拼接）。非空即在末尾渲染生成中的助手卡片。 */
  streamText?: string;
  /** 已被 assistant 事件收口的流式文本（用于免掉最终卡片的重复揭示动画）。 */
  finalizedStreamText?: string;
  /** 输入框回填指令（F4「编辑重发」）：透传给 Composer，把末条用户消息填回输入框。 */
  composerSeed?: ComposerSeed | null;
  /** 队列模式的排队消息坞（2026-10-31）：空队列时 Composer 不渲染任何东西。 */
  queue?: ChatQueueView;
  onEventClick: (ev: ThreadEvent) => void;
  /** 点击助手回复中的文件路径链接时，在右侧文件面板打开（而不是跳外链）。 */
  onOpenFile?: (path: string) => Promise<boolean> | boolean | void;
  /**
   * 在右栏网页标签打开一个地址（助手消息里的本地 dev server URL / 预览链接）。
   * 只对回环地址显示入口（见 ExternalLinkCards）。
   */
  onOpenUrl?: (url: string) => void;
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
  /**
   * 当前模型可选的推理强度档位（G11/W1 补：官方类型把"App 传了、这里没声明"这件事故暴露出来了）。
   *
   * **修的是真缺陷**：`App` 一直在给 `StreamView` 传 `reasoningOptions`，而这里既没声明、渲染 `Composer`
   * 时也没转发 ⇒ 会话实际的推理档位清单被**静默丢弃**，Composer 的推理选择器只能退回内置兜底列表。
   * 旧的手写类型垫片给未知属性留了索引签名逃生舱，于是这件事在类型层完全看不见。
   */
  reasoningOptions?: string[];
  permission: string;
  /** 当前会话 id（AddMenu / 上下文容量面板维度）。 */
  threadId?: string | null;
  /** 应用会话模式（转发给 Composer → AddMenu；控制器决定立即落盘还是暂存）。 */
  onApplyMode?: (patch: {
    goal?: string;
    planMode?: boolean;
    sketchMode?: boolean;
  }) => Promise<'applied' | 'deferred'>;
  /** 轻提示（AddMenu / 容量面板加载失败等）。 */
  onToast?: (msg: string, kind?: 'info' | 'err') => void;
  /** 跳到右侧某面板（AddMenu 点插件时打开「插件」页）。 */
  onOpenTab?: (key: string) => void;
  /** 加载历史会话（AddMenu 搜索命中为聊天时）。 */
  onLoadThread?: (id: string) => void;
  /**
   * 把一段文本填进底部输入框（空态「快速开始」示例用；实现见 `ComposerController.seedDraft`）。
   *
   * 刻意**不是** `onSend`：示例是给人改的模板，且直接发送会立刻消耗真实额度——
   * 第一次点按钮就花钱，对客户是惊吓不是引导。缺省时示例区不渲染（组件仍可用）。
   */
  onUseStarter?: (text: string) => void;
  /** 回合进行中——为真时显示思考/工具过程，结束后隐藏只留结果。 */
  busy?: boolean;
  /** 当前正在调用的工具名（无则显示"思考中"），透传给 Composer 状态条。 */
  activeTool?: string | null;
  /**
   * 待作答的提问（服务端 `question.request` 上行）：渲染在输入框正上方的可作答提问卡。
   *
   * 为什么挂在输入框上方而不是塞进对话流：提问是「要用户现在做一件事」，必须与输入框
   * 同屏（对话流可能被滚走、也可能根本没有对应的 question 事件）。
   */
  question?: QuestionRequest | null;
  /** 提交提问作答（透传给 QuestionCard → AppController.answerQuestion）。 */
  onAnswerQuestion?: (answers: QuestionAnswerSubmission[]) => Promise<void>;
  /** 提问等待到期（透传给 QuestionCard；服务端会按「未作答」继续）。 */
  onQuestionExpired?: (requestId: string) => void;
  /** ApiClient（给 Composer 附件 FilePicker 走 attach.read 用）。 */
  api: ApiClient;
  onModelChange: (v: string) => void;
  onReasoningChange: (v: string) => void;
  onPermissionChange: (v: string) => void;
  disabled?: boolean;
  /** 当前会话标题（中栏头；空串显示「新会话」）。 */
  sessionTitle?: string;
  /** 当前项目绝对路径（中栏「项目 / 线程」面包屑；空串不渲染项目段）。 */
  workspacePath?: string;
  /** 当前会话服务端有效时长（ms；undefined 表示历史会话没有该字段）。 */
  sessionActiveMs?: number;
  /** SSE 三态（透传给状态栏的连接口径；缺省不显示状态栏右段）。 */
  streamState?: 'open' | 'connecting' | 'closed';
  /** 模型适配器摘要（状态栏左段，如 `openai · gpt-4o`）。 */
  adapter?: string;
  /**
   * 编排运行态（可选）：有「已结束但未成功」的运行时，状态栏会出现一键续跑芯片。
   *
   * 放在状态栏而不是只放「编排」面板里，是为了降低学习成本（2026-10-08 用户反馈）：
   * 用户不必先学会「全部面板 → 编排」这套导航，低头就能看见「有东西没跑完 + 一键续跑」。
   */
  graphRuns?: Record<string, GraphRunState>;
  /** 续跑回调（与「编排」面板卡片共用同一实现 `GraphController.resumeRun`）。 */
  onGraphResume?: (runId: string, name: string) => void;
  /** 打开左栏抽屉（仅窄屏渲染的汉堡按钮）。 */
  onToggleLeft?: () => void;
  /** 切换右栏（桌面=收起/展开面板；移动=抽屉）。 */
  onToggleRight?: () => void;
  /** 右栏当前是否收起（中栏头切换按钮的高亮态）。 */
  rightCollapsed?: boolean;
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
function renderEventNode(ev: ThreadEvent, ctx: EventCtx): React.ReactElement | null {
  const p = ev.payload || {};
  const node = (inner: React.ReactElement): React.ReactElement => (
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
          turnDurationMs={ctx.turnDurations.get(ev.id)}
          onEdit={() => ctx.onEditUser?.()}
        />,
      );
    case 'assistant':
      return node(
        <AssistantCard
          ev={ev}
          busy={ctx.busy}
          onOpenFile={ctx.onOpenFile}
          onOpenUrl={ctx.onOpenUrl}
          animate={!wasStreamed(p, ctx.finalizedStreamText)}
          onRegenerate={ev.id === ctx.lastAssistantId && ctx.busy !== true ? ctx.onRegenerate : undefined}
        />,
      );
    case 'reasoning':
      // 正常路径由 ThinkingTrail 直接渲染（同一条轨迹里带状态与展开）；
      // 这里是裸 reasoning 块的兜底（历史/异常切片），保证内容不以 JSON 露出来。
      return <ReasoningStep key={ev.id} ev={ev} />;
    case 'tool_call': {
      const callId = (p.callId as string) || ev.id;
      return (
        <ToolCallCard
          key={ev.id}
          ev={ev}
          res={ctx.toolResults[callId]}
          onEventClick={ctx.onEventClick}
          onOpenFile={ctx.onOpenFile}
        />
      );
    }
    case 'tool_result':
      // 已被调用卡内联的结果不再单独渲染；孤儿结果（调用被历史截断）折叠成一行。
      if (ctx.toolCallIds.has((p.callId as string) || '')) return null;
      return renderStandaloneToolResult(ev, p);
    case 'system':
      return renderSystemNode(p, node);
    case 'todo':
      return renderTodoNode(p, node);
    case 'plan':
      return renderPlanNode(p, node);
    case 'question':
      return renderQuestionNode(p, ctx, node);
    case 'turn_diff':
      // 回合结果由 renderBlockNode 的 turn_summary 块整体渲染；这里不会走到，保留 null 兜底。
      return null;
    case 'session_meta':
      // 会话元数据（工作区标记）：仅供会话收纳，不在对话流里渲染。
      return null;
    case 'model':
      // 模型用量事件：token 统计在「指标」面板看，对话流里渲染只会是一坨 JSON。
      return null;
    default:
      return renderUnknownNode(ev, p, node);
  }
}

/**
 * 渲染单个可视块：过程簇或单事件。
 * @param b 可视块
 * @param ctx 渲染上下文
 * @returns 块节点
 */
function renderBlockNode(b: DisplayBlock, ctx: EventCtx): React.ReactElement | null {
  if (b.kind === 'process') {
    return (
      <ThinkingTrail
        key={b.key}
        events={b.events}
        startedAt={b.startedAt}
        endedAt={b.endedAt}
        // busy 是会话级状态：新回合开跑时，历史回合的轨迹不能跟着进入「思考中」。
        busy={b.current === true && ctx.busy === true}
        fresh={b.current === true && ctx.clusterFresh}
        renderEvent={(ev) => renderEventNode(ev, ctx)}
      />
    );
  }
  if (b.kind === 'turn_summary') {
    return (
      <TurnSummaryCard
        key={b.key}
        events={b.events}
        onOpenFile={ctx.onOpenFile}
      />
    );
  }
  return renderEventNode(b.event, ctx);
}

/** 虚拟窗口计算器：无状态，全组件共用一个实例（避免每次渲染 new）。 */
const STREAM_WINDOW = new StreamWindow();

/**
 * 空洞修复时**两侧各多渲染**的块数：视口装不满（模型高估高度）时把窗口撑大，直到视口被真实内容
 * 覆盖。取 24 的依据：真机实测缺口来自「模型 88px 估算 vs 真实几十 px」的累积，一屏 581px 在
 * 最坏情形下需要多渲染十余块；24 留一倍余量，同时仍在虚拟化的常量成本内（DOM 块数上限 ≈
 * 一屏块数 + 2×overscan + 2×本值）。
 */
const HOLE_BOOST_BLOCKS = 24;

/** 滚动状态机（`useStreamScroll` 的产物）：虚拟窗口与测量所需的全部读写面。 */
interface StreamScroll {
  /** 滚动容器。 */
  readonly streamRef: React.RefObject<HTMLDivElement | null>;
  /** 已渲染块的 DOM 登记表（key → 元素）。 */
  readonly blockElsRef: React.RefObject<Map<string, HTMLElement>>;
  /** 上一次滚动 / 提交时的贴底状态：仅在底部才自动贴底。 */
  readonly stickyRef: React.RefObject<boolean>;
  /** 最近一次由代码写出的 scrollTop（用于区分程序化滚动与用户上滚）。 */
  readonly programmaticTopRef: React.RefObject<number | null>;
  /** 逐块真实高度索引（懒初始化，本组件实例独享）。 */
  readonly indexRef: React.RefObject<BlockHeightIndex | null>;
  /** 上一帧已提交的 padTop（px），用于测量后的滚动锚定补偿。 */
  readonly lastPadTopRef: React.RefObject<number>;
  /** 当前滚动偏移（驱动虚拟窗口计算）。 */
  readonly scrollTop: number;
  /** 可视区高度（真实测量值；未测量到 0 时由 StreamWindow 用兜底高度）。 */
  readonly viewportHeight: number;
  /** 空洞加渲块数（0 = 未加渲）。 */
  readonly holeBoost: number;
  /** 测量回填计数器（索引变化后置位触发一次重渲染）。 */
  readonly measureTick: number;
  /** 置空洞加渲（0 → HOLE_BOOST_BLOCKS 的单次迁移）。 */
  readonly setHoleBoost: React.Dispatch<React.SetStateAction<number>>;
  /** 测量回填后请求一次重渲染。 */
  readonly setMeasureTick: React.Dispatch<React.SetStateAction<number>>;
  /** 滚动处理器（虚拟化的唯一驱动源）。 */
  readonly onScroll: (e: React.SyntheticEvent) => void;
}

/**
 * 滚动状态机：贴底意图 / 程序化滚动标记 / 可视高度 / 空洞加渲计数 + 三个接线 effect。
 *
 * 留在本文件的原因见文件头（源码级接线守卫直接读本文件）。
 *
 * ## 空洞修复为什么是「多渲染」而不是「写回 scrollTop」（holeBoost 的由来）
 *
 * 2026-09-27 用户两次报障的最终结论：① 写回会把用户拖到的位置推回去（「滚动被回退」）；
 * ② 写回发生在布局效应里，可能形成同步更新循环（React #185）。而空洞的**真实成因**是
 * 「索引高度与真实布局漂移 ⇒ 渲染窗口装不满一屏」，正确解法是**多渲染几块**把视口填满 ——
 * 用户的滚动位置从头到尾不用改。粘性到用户下次滚动才复位。
 *
 * 终止性（为什么不需要旧版的「滚动预算」闸）：`holeBoost` 只做 0 → HOLE_BOOST_BLOCKS 的**单次
 * 迁移**——已置位后守卫短路、`setHoleBoost(24)` 同值 bail，循环在结构上不可自我续期；且本路径
 * 从不写 scrollTop（旧 #185 来自已被删除的「写回」变体）。2026-10-07 移除预算闸：真机实测它会在
 * 长滚动序列里耗尽（每次滚动只补 2 次，而测量引发的多次布局效应都会消耗它），让该修的洞修不了。
 * @param events 事件数组（贴底 effect 的依赖）
 * @param liveInputs 流式输入（贴底 effect 的依赖）
 * @param streamText 流式正文（长回答逐段变高时持续贴底）
 * @param threadId 当前会话 id（变化即复位滚动状态）
 * @returns 滚动状态与接线
 */
function useStreamScroll(
  events: readonly ThreadEvent[],
  liveInputs: readonly LiveInput[],
  streamText: string | undefined,
  threadId: string | null | undefined,
): StreamScroll {
  const streamRef = React.useRef<HTMLDivElement | null>(null);
  const stickyRef = React.useRef<boolean>(true);
  const programmaticTopRef = React.useRef<number | null>(null);
  const [scrollTop, setScrollTop] = React.useState<number>(0);
  const [viewportHeight, setViewportHeight] = React.useState<number>(0);
  const indexRef = React.useRef<BlockHeightIndex | null>(null);
  if (indexRef.current === null) indexRef.current = new BlockHeightIndex({ estimate: DEFAULT_ITEM_HEIGHT });
  const blockElsRef = React.useRef<Map<string, HTMLElement>>(new Map());
  const lastPadTopRef = React.useRef<number>(0);
  const [measureTick, setMeasureTick] = React.useState<number>(0);
  /** 空洞加渲块数：只在视口装不满时做 0 → HOLE_BOOST_BLOCKS 的**单次**迁移（见函数 JSDoc）。 */
  const [holeBoost, setHoleBoost] = React.useState<number>(0);

  // 切会话：滚动位置与贴底意图都属于上一个会话，必须复位。否则在 A 里上滚后打开 B，
  // B 会停在旧偏移、且 `stickyRef=false` 让之后的新内容再也不自动贴底（会话时钟在
  // useSessionClock 里按 `switched` 复位，滚动这里此前漏了）。
  React.useEffect(() => {
    stickyRef.current = true;
    programmaticTopRef.current = 0;
    setScrollTop(0);
    setHoleBoost(0);
  }, [threadId]);

  // 新事件 / 流式输入 / 流式正文到达后锚定到底部（长会话里用户不必手动追）；兼作挂载即滚动。
  // 同时同步可视高度：首屏拿到 DOM 真实高度后虚拟窗口才准。
  // 依赖含 streamText：长回答逐段变高时，处于底部的用户也能被持续贴底（上滚后 stickyRef=false 即不再拉回）。
  React.useEffect(() => {
    const el = streamRef.current;
    if (!el) return;
    if (el.clientHeight !== viewportHeight) setViewportHeight(el.clientHeight);
    el.scrollTop = StreamWindow.stickyScrollTop(stickyRef.current, el);
    // 记录实际落点（浏览器会 clamp），供 onScroll 区分程序化滚动。
    programmaticTopRef.current = el.scrollTop;
  }, [events, liveInputs, streamText]);

  /**
   * 滚动：记录贴底状态并按真实 scrollTop 重算窗口（virtualization 的唯一驱动源）。
   * @param e 滚动事件（零 DOM 桩下不会被触发）
   */
  const onScroll = (e: React.SyntheticEvent): void => {
    const el = e.currentTarget as HTMLDivElement | null;
    if (!el) return;
    // 程序化滚动（我们自己设的 scrollTop）只更新窗口，不改变「是否贴底」的用户意图；
    // 否则内容变高后会被误判成「用户上滚」，结果卡底部再也滚不到（2026-10-20 用户报「缺封口」）。
    const isProgrammatic =
      programmaticTopRef.current !== null &&
      Math.abs(el.scrollTop - programmaticTopRef.current) <= 1;
    programmaticTopRef.current = null;
    if (!isProgrammatic) {
      // 用户滚动了 ⇒ 把「空洞加渲」复位（位置是用户说了算，新位置重新按需修复）。
      if (holeBoost !== 0) setHoleBoost(0);
      stickyRef.current = StreamWindow.atBottom(el);
    }
    if (el.scrollTop !== scrollTop) setScrollTop(el.scrollTop);
    if (el.clientHeight !== viewportHeight) setViewportHeight(el.clientHeight);
  };

  return {
    streamRef,
    blockElsRef,
    stickyRef,
    programmaticTopRef,
    indexRef,
    lastPadTopRef,
    scrollTop,
    viewportHeight,
    holeBoost,
    measureTick,
    setHoleBoost,
    setMeasureTick,
    onScroll,
  };
}

/**
 * 计算本帧虚拟窗口：先按逐块真实高度算，再在「空洞加渲」置位时两侧各扩 HOLE_BOOST_BLOCKS 块。
 * @param keys 全部块 key（与 blocks 同序）
 * @param index 逐块高度索引
 * @param scrollTop 当前滚动偏移
 * @param viewportHeight 可视区高度
 * @param holeBoost 空洞加渲块数（0 = 不加渲）
 * @returns 窗口指标（start/end/rendered/padTop/padBottom/total）
 */
function computeStreamWindow(
  keys: readonly string[],
  index: BlockHeightIndex,
  scrollTop: number,
  viewportHeight: number,
  holeBoost: number,
): StreamWindowMetrics {
  const base = STREAM_WINDOW.computeWithHeights(keys, (k) => index.get(k), scrollTop, viewportHeight);
  if (holeBoost <= 0) return base;
  const start = Math.max(0, base.start - holeBoost);
  const end = Math.min(keys.length, base.end + holeBoost);
  return {
    start,
    end,
    rendered: end - start,
    padTop: index.prefix(keys, start),
    padBottom: index.prefix(keys, keys.length) - index.prefix(keys, end),
    total: base.total,
  };
}

/** 逐块测量 + 空洞修复的入参（把十来个状态收成一组，免得 hook 签名长到读不懂）。 */
interface BlockMeasurementDeps {
  /** 滚动状态机（refs 与计数都在里面）。 */
  readonly scroll: StreamScroll;
  /** 全部块 key（与 blocks 同序）。 */
  readonly keys: readonly string[];
  /** 事件数组（高度索引裁剪的失效判据）。 */
  readonly events: readonly ThreadEvent[];
  /** 回合是否进行中（裁剪 effect 的失效判据）。 */
  readonly busy: boolean | undefined;
  /** 本帧虚拟窗口。 */
  readonly win: StreamWindowMetrics;
  /** 全部块数（layout effect 的依赖之一）。 */
  readonly blockCount: number;
}

/**
 * 逐块真实高度回填 + 空洞修复（**只加渲，绝不移动用户的滚动位置**）。
 *
 * 留在本文件的原因见文件头：`web/test/streamWindowAnchor.test.ts` 读本文件文本钉住
 * 「加渲 setter 必须由 `needsAnchorRepair` + 单次迁移守卫触发」。
 * @param deps 入参（滚动状态 + 模型尺寸）
 */
function useBlockMeasurements(deps: BlockMeasurementDeps): void {
  const { keys, events, busy, win, blockCount } = deps;
  const { streamRef, blockElsRef, stickyRef, programmaticTopRef, indexRef, holeBoost } = deps.scroll;
  const { setHoleBoost, measureTick, setMeasureTick } = deps.scroll;

  // 事件集合变化时裁剪高度索引：丢弃已不存在的块，防长会话无限增长（index 仅存实测值）。
  React.useEffect(() => {
    const keep = new Set(keys);
    indexRef.current!.prune(keep);
  }, [events, busy]);

  // 逐块真实高度回填 + 空洞修复：实测已渲染块高度写入索引；**若视口基本没内容（空洞）**，
  // 则多渲染一批块把视口填满（见下），**绝不移动用户的滚动位置**。
  // 索引变化才触发一次重渲染，随后实测值稳定、本 effect 直接返回，不会死循环。
  React.useLayoutEffect(() => {
    const idx = indexRef.current!;
    const el = streamRef.current;
    let changed = false;
    for (const [k, node] of blockElsRef.current) {
      const h = node.offsetHeight; // .sw-block 为 flow-root，offsetHeight 已含子块 margin
      if (h > 0 && idx.set(k, h)) changed = true;
    }
    if (!changed && el === null) return;
    if (el && !stickyRef.current) {
      // 空洞修复：真机实测（真服务 + 真会话 sess_mujn1om2_1，跳转滚动 12 档）里有两档覆盖率只有
      // 8% / 36%（模型高估了区块高度 ⇒ 渲染窗口装不满一屏 ⇒ 视口下半截落在占位区）。
      //
      // **修法演进（三次，前两次都被用户实测打回，留档防回退）**：
      // ① 无条件把「锚块的真实偏移」对齐到「模型偏移」（写回 scrollTop）⇒ 拖到没渲染过的区域时，
      //    该区域上方 overscan 块本轮才第一次被测量（估算 88px vs 真实几百 px），差量一次性算进
      //    校正量 ⇒ **位置被推回原来那一带**（实测 943→2489，回退 1546px；3772→4614；1650→1983）。
      // ② 加闸「只有视口 < 50% 覆盖才动」⇒ 用户仍报「滚动依旧回退、无法滚到顶」：近顶部那两档
      //    覆盖率本就是 8% / 36%，一往上拖就被推回去（实测 236→569、463→1411）。
      // ③ **本版：不改位置，只多渲染**。用户的滚动位置全程不动；空洞靠「两侧各多渲染
      //    HOLE_BOOST_BLOCKS 块」把视口填满（粘性到用户下次滚动）。
      const anchors: { index: number; top: number; bottom: number }[] = [];
      const viewportTop = el.getBoundingClientRect().top;
      for (let i = 0; i < keys.length; i++) {
        const node = blockElsRef.current.get(keys[i]!);
        if (node === undefined) continue;
        const rect = node.getBoundingClientRect();
        anchors.push({ index: i, top: rect.top, bottom: rect.bottom });
      }
      // **必须有硬上界**：修复会 setState ⇒ 本布局效应可能再次运行。终止性由状态机的单次迁移保证：
      // holeBoost 0→24 后守卫短路、同值 bail（见 holeBoost 的 JSDoc）——不需要旧版的「滚动预算」闸，
      // 预算在长滚动序列里会被测量引发的布局效应耗尽，让该修的洞修不了（2026-10-07 真机实测）。
      if (holeBoost < HOLE_BOOST_BLOCKS && StreamWindow.needsAnchorRepair(viewportTop, el.clientHeight, anchors)) {
        setHoleBoost(HOLE_BOOST_BLOCKS);
      }
    }
    if (changed) {
      setMeasureTick((t) => t + 1);
      // 测量回填后若用户仍在底部，补一次贴底：结果卡/长卡片挂载时先按估算高度撑开，
      // 实测后内容会变高并把卡片底部推到视口外（用户看到「卡片缺了圆角封口」）。
      // 只在原本贴底时补，绝不打断向上翻阅的用户；位置从不由测量反向移动。
      if (el !== null && stickyRef.current) {
        el.scrollTop = el.scrollHeight;
        programmaticTopRef.current = el.scrollTop;
      }
    }
  }, [win.start, win.end, blockCount, measureTick, holeBoost]);
}

/**
 * 组装事件渲染上下文（只读快照）：块渲染函数（renderEventNode / renderBlockNode）只吃它。
 * @param props StreamView 入参
 * @param model 事件流模型
 * @param clusterFresh 是否刚收尾（过程簇回闪）
 * @returns 渲染上下文
 */
function buildEventCtx(props: StreamViewProps, model: StreamModel, clusterFresh: boolean): EventCtx {
  return {
    toolResults: props.toolResults,
    onEventClick: props.onEventClick,
    onOpenFile: props.onOpenFile,
    onOpenUrl: props.onOpenUrl,
    busy: props.busy,
    lastUserId: model.lastUserId,
    lastAssistantId: model.lastAssistantId,
    onEditUser: props.onEditUser,
    onRegenerate: props.onRegenerate,
    finalizedStreamText: props.finalizedStreamText ?? '',
    toolCallIds: model.toolCallIds,
    turnDurations: model.turnDurations,
    questionPending: props.question != null,
    clusterFresh,
  };
}

/**
 * 事件流组件：渲染事件块、流式占位与底部输入区，并锚定滚动到底部。
 *
 * 本组件只做**数据编排**（模型 → 窗口 → 各分区），DOM 结构分别由 StreamFeed /
 * StreamBottom / StreamStatusBar 产出；函数体刻意保持薄（check.mjs 铁律 80 行）。
 * @param props 组件入参
 * @returns 中栏节点
 */
export function StreamView(props: StreamViewProps): React.ReactElement {
  /** 中栏视图：对话流 / 工具轨迹（头部标签切换；默认对话）。 */
  const [view, setView] = React.useState<ChatViewKind>('chat');
  const scroll = useStreamScroll(props.events, props.liveInputs, props.streamText, props.threadId);
  const { sessionClock, clusterFresh } = useSessionClock(props.sessionActiveMs, props.busy, props.threadId);
  const model = useStreamModel(props.events, props.busy === true);
  const ctx = buildEventCtx(props, model, clusterFresh);
  const streaming = props.streamText ?? '';
  // 虚拟化的单位是「可视块」（过程事件已合并成簇），末尾的流式行恒在窗口之外单独渲染。
  const tailCount = props.liveInputs.length + (streaming !== '' ? 1 : 0);
  // 真实高度路径：用 BlockHeightIndex 回填的逐块高度算窗口（padTop/padBottom 为前缀偏移）。
  // 未测到的块由索引回落到估算值，故首屏/长会话顶部与「统一估算」行为一致、不崩。
  const win = computeStreamWindow(
    model.keys,
    scroll.indexRef.current!,
    scroll.scrollTop,
    scroll.viewportHeight,
    scroll.holeBoost,
  );
  // 记录本帧已提交的 padTop，供测量后做滚动锚定补偿，避免内容跳动。
  scroll.lastPadTopRef.current = win.padTop;
  useBlockMeasurements({
    scroll,
    keys: model.keys,
    events: props.events,
    busy: props.busy,
    win,
    blockCount: model.blocks.length,
  });
  return (
    <div className="col center">
      <ChatHeader
        title={props.sessionTitle ?? ''}
        projectPath={props.workspacePath}
        busy={props.busy === true}
        duration={sessionClock.visible ? sessionClock.label : ''}
        durationState={sessionClock.state}
        view={view}
        onView={setView}
        onToggleLeft={props.onToggleLeft}
        onToggleRight={props.onToggleRight}
        rightCollapsed={props.rightCollapsed}
      />
      <StreamFeed
        stream={props}
        view={view}
        win={win}
        blocks={model.blocks}
        streaming={streaming}
        tailCount={tailCount}
        onScroll={scroll.onScroll}
        streamRef={scroll.streamRef}
        blockElsRef={scroll.blockElsRef}
        renderBlock={(b) => renderBlockNode(b, ctx)}
      />
      <TraceView
        events={props.events}
        liveInputs={props.liveInputs}
        toolResults={props.toolResults}
        hidden={view !== 'trace'}
      />
      <StreamBottom {...props} />
      <StreamStatusBar {...props} />
    </div>
  );
}
