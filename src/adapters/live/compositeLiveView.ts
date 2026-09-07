import type { ToolInputDelta } from '../../ports/model.js';
import type { ToolInputSink } from '../../ports/toolInputSink.js';

/**
 * @beta
 * 组合实时视图（#B3 web）：聚合多个 ToolInputSink，onToolInput 转发给全部子 sink。
 *
 * RuntimeFactory 默认以此作为 `runtime.live`，内置 ConsoleLiveView（TTY 实时刷新）；
 * serve 模式下再由 CLI 注入 WebLiveView（广播给 Web UI），实现「同一份增量、多端呈现」。
 */
export class CompositeLiveView implements ToolInputSink {
  readonly name = 'composite-live-view';
  private readonly sinks: ToolInputSink[] = [];

  constructor(initial: readonly ToolInputSink[] = []) {
    this.sinks.push(...initial);
  }

  /** 追加一个子实时视图（去重）。 */
  addSink(sink: ToolInputSink): void {
    if (!this.sinks.includes(sink)) this.sinks.push(sink);
  }

  /** 移除一个子实时视图。 */
  removeSink(sink: ToolInputSink): void {
    const idx = this.sinks.indexOf(sink);
    if (idx >= 0) this.sinks.splice(idx, 1);
  }

  onToolInput(delta: ToolInputDelta): void {
    for (const sink of this.sinks) sink.onToolInput(delta);
  }
}
