import type { SessionEvent } from '../ports/runtime/event.ts';
import { AgUiEventMapper } from './aguiEventMapper.ts';
import type { AgUiEvent } from './aguiProtocol.ts';

/** 事件流构造参数。 */
export interface AgUiEventStreamOptions {
  /** 会话线程 id。 */
  readonly threadId: string;
  /** 本次 run id。 */
  readonly runId: string;
}

/**
 * 把 OmniHarness 会话事件流包装为**完整 AG-UI 事件流**（RUN_STARTED → … → RUN_FINISHED / RUN_ERROR）。
 *
 * 取消约定：AG-UI 没有独立的取消事件，本适配层用 `RUN_ERROR { code: 'CANCELLED' }` 收尾，
 * 与「run 未完成」的语义一致，前端可按 code 区分真实错误与用户取消。
 */
export class AgUiEventStream {
  /** 单 run 映射器（含状态与最终文本累积）。 */
  private readonly mapper: AgUiEventMapper;

  /**
   * @param options 线程 / run 标识。
   */
  public constructor(options: AgUiEventStreamOptions) {
    this.mapper = new AgUiEventMapper(options);
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
      for await (const event of events) {
        if (signal?.aborted === true) {
          yield this.mapper.runError('已取消', 'CANCELLED');
          return;
        }
        for (const mapped of this.mapper.map(event)) yield mapped;
      }
      if (signal?.aborted === true) {
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
}
