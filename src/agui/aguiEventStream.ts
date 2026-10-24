import type { SessionEvent } from '../ports/runtime/event.ts';
import { AgUiEventMapper } from './aguiEventMapper.ts';
import type { AgUiEvent } from './aguiProtocol.ts';

/** 事件流构造参数。 */
export interface AgUiEventStreamOptions {
  /** 会话线程 id。 */
  readonly threadId: string;
  /** 本次 run id。 */
  readonly runId: string;
  /** run 开始/恢复时的历史消息（非空才发 MESSAGES_SNAPSHOT）。 */
  readonly messages?: readonly unknown[] | undefined;
}

/**
 * 把 OmniHarness 会话事件流包装为**完整 AG-UI 事件流**（RUN_STARTED → … → RUN_FINISHED / RUN_ERROR）。
 *
 * 顺序约定：RUN_STARTED 之后先发可选的 `MESSAGES_SNAPSHOT`（仅当调用方提供非空历史消息），
 * 再逐条发映射事件；工具/子代理事件额外产出 `ACTIVITY_*`（与 `map` 分离，不改既有序列）。
 *
 * 取消约定：AG-UI 没有独立的取消事件，本适配层用 `RUN_ERROR { code: 'CANCELLED' }` 收尾，
 * 与「run 未完成」的语义一致，前端可按 code 区分真实错误与用户取消。
 */
export class AgUiEventStream {
  /** 单 run 映射器（含状态与最终文本累积）。 */
  private readonly mapper: AgUiEventMapper;
  /** run 开始/恢复时的历史消息（可缺省）。 */
  private readonly messages: readonly unknown[] | undefined;

  /**
   * @param options 线程 / run 标识与可选历史消息。
   */
  public constructor(options: AgUiEventStreamOptions) {
    this.mapper = new AgUiEventMapper(options);
    this.messages = options.messages;
  }

  /**
   * 逐条产出 AG-UI 事件（异步生成器）。
   * @param events 源会话事件流（Agent 运行器产出）。
   * @param signal 取消信号（aborted 后在下一条事件前收尾为 RUN_ERROR/CANCELLED）。
   * @returns AG-UI 事件异步迭代器。
   */
  public async *run(
    events: AsyncIterable<SessionEvent>,
    signal?: AbortSignal,
  ): AsyncIterableIterator<AgUiEvent> {
    yield this.mapper.runStarted();
    try {
      if (this.isAborted(signal)) {
        yield this.mapper.runError('已取消', 'CANCELLED');
        return;
      }
      for (const snapshot of this.mapper.messagesSnapshot(this.messages)) {
        yield snapshot;
      }
      for await (const event of events) {
        if (this.isAborted(signal)) {
          yield this.mapper.runError('已取消', 'CANCELLED');
          return;
        }
        for (const mapped of this.mapper.map(event)) yield mapped;
        for (const activity of this.mapper.activities(event)) yield activity;
      }
      if (this.isAborted(signal)) {
        yield this.mapper.runError('已取消', 'CANCELLED');
        return;
      }
      yield this.mapper.runFinished();
    } catch (error) {
      yield this.mapper.runError(
        error instanceof Error ? error.message : String(error),
        'RUN_ERROR',
      );
    }
  }

  /**
   * 判断取消信号是否已触发。
   *
   * 独立成方法而不是内联比较：TypeScript 的控制流会把首次 `signal?.aborted === true`
   * 守卫后的值窄化成 `false | undefined`，内联的后续比较会被判成「恒假」。
   * @param signal 取消信号（可缺省）。
   * @returns 已取消时为 true。
   */
  private isAborted(signal: AbortSignal | undefined): boolean {
    return signal?.aborted === true;
  }
}
