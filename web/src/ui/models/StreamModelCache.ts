import type { ThreadEvent } from '../../types/models.js';
import { buildDisplayBlocks, type DisplayBlock } from '../textUtils.js';

/**
 * 事件流的**渲染输入模型**（块 / 键 / 末条 id / 本轮工具调用 id）。
 *
 * 为什么单独成文件：这些派生都是 O(事件数)，而 `StreamView` 的**每次滚动帧**都会重渲染
 * （`scrollTop` 是 state）。审计 §2.5 实测每帧 ≈180 µs@1000、≈510 µs@3000 事件，
 * 其中绝大部分就是这几项全量重算——滚动时它们**一个输入都没变**。
 */
export interface StreamModel {
  /** 可视块（过程事件已合并成簇）。 */
  readonly blocks: readonly DisplayBlock[];
  /** 每个块的稳定 key（与 blocks 同序）。 */
  readonly keys: readonly string[];
  /** 最后一条用户消息 id（仅它可编辑重发）。 */
  readonly lastUserId: string;
  /** 最后一条助手消息 id（仅它可重新生成）。 */
  readonly lastAssistantId: string;
  /** 本轮出现过的工具调用 id（判断 tool_result 是否已被调用卡内联）。 */
  readonly toolCallIds: ReadonlySet<string>;
}

/** 模型缓存观测（测试与诊断用）。 */
export interface StreamModelCacheStats {
  /** 实际重算次数。 */
  readonly computes: number;
  /** 命中次数（复用上一次结果）。 */
  readonly hits: number;
}

/**
 * 单击（单槽位）模型缓存：React 的渲染是「同一批 props 反复渲染」，
 * 故只保留最近一次的输入指纹就足够，且**不需要淘汰策略**。
 *
 * 失效判据＝`(events 引用, events.length, busy)`：
 *  - 引用变化 ⇒ 新数组（本仓 reducer 不可变，新事件必是新数组）；
 *  - **length 也纳入** ⇒ 兜住「就地 push 同一个数组」的写法（引用不变但内容变了）；
 *  - `busy` 变化会影响过程簇的折叠口径，必须重算。
 *
 * 残留边界（如实登记）：**长度不变的就地内容修改**检测不到——那类写法本身就会让 React 漏渲染，
 * 不是本缓存引入的问题。
 */
export class StreamModelCache {
  /** 上一次输入指纹与产物。 */
  private last:
    | { readonly events: readonly ThreadEvent[]; readonly length: number; readonly busy: boolean; readonly model: StreamModel }
    | null = null;

  /** 重算计数。 */
  private computes = 0;

  /** 命中计数。 */
  private hits = 0;

  /**
   * 取（必要时重算）事件流模型。
   * @param events 事件数组（引用 + 长度共同构成失效判据）。
   * @param busy 回合是否进行中（影响过程簇折叠口径）。
   * @returns 模型；同一输入重复调用返回**同一对象**。
   */
  public get(events: readonly ThreadEvent[], busy: boolean): StreamModel {
    const last = this.last;
    if (last !== null && last.events === events && last.length === events.length && last.busy === busy) {
      this.hits += 1;
      return last.model;
    }
    this.computes += 1;
    const model = StreamModelCache.build(events, busy);
    this.last = { events, length: events.length, busy, model };
    return model;
  }

  /**
   * 观测计数。
   * @returns `{ computes, hits }`。
   */
  public stats(): StreamModelCacheStats {
    return { computes: this.computes, hits: this.hits };
  }

  /**
   * 清空缓存与计数（会话切换/测试用）。
   * @returns 无返回值。
   */
  public clear(): void {
    this.last = null;
    this.computes = 0;
    this.hits = 0;
  }

  /**
   * 纯计算（无缓存）：供测试对拍与需要强制重算的调用方使用。
   * @param events 事件数组。
   * @param busy 回合是否进行中。
   * @returns 模型。
   */
  public static build(events: readonly ThreadEvent[], busy: boolean): StreamModel {
    const blocks = buildDisplayBlocks(events, busy);
    const keys = blocks.map((b) => (b.kind === 'process' ? b.key : b.event.id));
    let lastUserId = '';
    let lastAssistantId = '';
    const toolCallIds = new Set<string>();
    for (const e of events) {
      if (e.type === 'user') lastUserId = e.id;
      else if (e.type === 'assistant') lastAssistantId = e.id;
      else if (e.type === 'tool_call') {
        const p = e.payload || {};
        toolCallIds.add((p.callId as string) || e.id);
      }
    }
    return { blocks, keys, lastUserId, lastAssistantId, toolCallIds };
  }
}
