/**
 * 会话摘要（`sessions.list` 需要的轻量字段）与**纯事件遍历构建器**。
 *
 * ## 为什么单独成模块
 *
 * 同一套摘要口径原本只存在于 `SessionScanCache.parseSummary`（逐行解析）。现在有两个消费者：
 *  1. 列表读取：文件旁路摘要有效时**不再读 `.jsonl`**；
 *  2. 落盘侧：回合结束时把摘要写到 `<session>.jsonl.summary.json`，供下一次列表直读。
 *
 * 口径必须只有一份，否则「列表显示」与「旁路摘要」会各说各话。本模块只依赖**已解析的
 * `SessionEvent`**，不碰文件系统，因此 server 与 adapter 都能用。
 *
 * ## 口径（与历史实现逐字段一致）
 *
 * - `turns`：`user` 事件数；
 * - `label`：首条 `user` 内容前 80 字（无自定义标题时作标签）；
 * - `mock`：`session_meta.model === 'mock'` / `tool_call.callId` 以 `mock_call_` 开头 /
 *   assistant 文案含「模拟模型适配器输出」/ `model` 事件名为 `mock`；
 * - `updatedAt`：最后一条带时间戳事件的时间（ISO 字符串）；
 * - `activeMs`：首末时间跨度减去「>5 分钟且后接 user」的空闲间隔；
 * - `idleGaps`：被剔除的空闲间隔个数。
 */

/** 会话摘要（`list` 需要的字段）。 */
export interface SessionSummary {
  /** 归属工作区（`session_meta.payload.workspace`；老存档可能没有）。 */
  readonly workspace?: string | undefined;
  /** 创建会话时记录的模型名（老存档没有；有 `model` 事件时回填）。 */
  readonly model?: string | undefined;
  /** 是否为 mock/演示会话（判据见模块头）。 */
  readonly mock: boolean;
  /** 首条用户消息前 80 字（无自定义标题时作标签）。 */
  readonly label: string;
  /** 用户回合数。 */
  readonly turns: number;
  /** 最后一条事件的时间戳（ISO 字符串；没有则为空串）。 */
  readonly updatedAt: string;
  /** 有效时长（ms）：首末事件间隔 − 空闲间隔。 */
  readonly activeMs: number;
  /** 被剔除的空闲间隔个数。 */
  readonly idleGaps: number;
}

/** 摘要构建所需的最小事件形状（`ParsedLine` 与 `SessionEvent` 都结构兼容）。 */
export interface SummaryEvent {
  /** 事件类型（缺失视为忽略）。 */
  readonly type?: string;
  /** 事件时间戳（ISO 串）。 */
  readonly timestamp?: string;
  /** 事件载荷（形状未知，构建器内部按对象判定）。 */
  readonly payload?: unknown;
}

/** 判定「用户离开」的最小间隔：5 分钟（与 tools/sessionTelemetry.mjs 同口径）。 */
const IDLE_GAP_MS = 5 * 60 * 1000;

/**
 * 摘要构建器：逐事件喂入，最后 `build()`。
 *
 * 之所以用可变累加器而不是纯函数：列表侧是**逐行流式解析**，不把整份事件数组留在内存；
 * 落盘侧已持有完整事件数组，直接循环喂入即可。两条路径共用同一段判定。
 */
export class SessionSummaryBuilder {
  private workspace: string | undefined;
  private model: string | undefined;
  private label = '';
  private turns = 0;
  private updatedAt = '';
  private mock = false;
  private firstTs: number | null = null;
  private prevTs: number | null = null;
  private idleMs = 0;
  private idleGaps = 0;

  /**
   * 吃进一条事件。
   * @param event 已解析的会话事件（最小形状）。
   * @returns 无返回值。
   */
  public add(event: SummaryEvent): void {
    const payload =
      event.payload !== null && typeof event.payload === 'object'
        ? (event.payload as Record<string, unknown>)
        : undefined;
    if (event.type === 'session_meta') {
      if (typeof payload?.['workspace'] === 'string') {
        this.workspace = payload['workspace'];
      }
      if (typeof payload?.['model'] === 'string') {
        this.model = payload['model'];
        if (this.model === 'mock') this.mock = true;
      }
    } else if (event.type === 'user') {
      if (this.label === '') {
        const content = payload?.['content'];
        if (typeof content === 'string') this.label = content.slice(0, 80);
      }
      this.turns += 1;
    } else if (event.type === 'tool_call') {
      const callId = payload?.['callId'];
      if (typeof callId === 'string' && callId.startsWith('mock_call_')) this.mock = true;
    } else if (event.type === 'assistant') {
      const content = payload?.['content'];
      if (typeof content === 'string' && content.includes('模拟模型适配器输出')) {
        this.mock = true;
      }
    } else if (event.type === 'model' && this.model === undefined) {
      const name = payload?.['model'];
      if (typeof name === 'string') {
        this.model = name;
        if (name === 'mock') this.mock = true;
      }
    }
    if (typeof event.timestamp === 'string') {
      this.updatedAt = event.timestamp;
      const ts = Date.parse(event.timestamp);
      if (Number.isFinite(ts)) {
        if (this.firstTs === null) this.firstTs = ts;
        if (this.prevTs !== null) {
          const gap = ts - this.prevTs;
          // 空闲 = 长间隔且间隔之后是用户消息（人离开后再回来）；模型生成延迟不算空闲。
          if (gap > IDLE_GAP_MS && event.type === 'user') {
            this.idleMs += gap;
            this.idleGaps += 1;
          }
        }
        this.prevTs = ts;
      }
    }
  }

  /**
   * 产出摘要。
   * @returns 会话摘要。
   */
  public build(): SessionSummary {
    const spanMs =
      this.firstTs === null || this.prevTs === null ? 0 : Math.max(0, this.prevTs - this.firstTs);
    return {
      ...(this.workspace !== undefined ? { workspace: this.workspace } : {}),
      ...(this.model !== undefined ? { model: this.model } : {}),
      mock: this.mock,
      label: this.label,
      turns: this.turns,
      updatedAt: this.updatedAt,
      activeMs: Math.max(0, spanMs - this.idleMs),
      idleGaps: this.idleGaps,
    };
  }

  /**
   * 从完整事件数组构建摘要。
   * @param events 会话事件（按文件顺序）。
   * @returns 会话摘要。
   */
  public static fromEvents(events: readonly SummaryEvent[]): SessionSummary {
    const builder = new SessionSummaryBuilder();
    for (const event of events) builder.add(event);
    return builder.build();
  }
}
