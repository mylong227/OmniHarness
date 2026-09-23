import type { ToolInputDelta } from '../../ports/model/model.js';
import type { ToolInputSink } from '../../ports/tool/toolInputSink.js';

/**
 * @beta
 * 组合实时视图（#B3 web）：聚合多个 ToolInputSink，onToolInput 转发给全部子 sink。
 *
 * createRuntime 默认以此作为 `runtime.live`，内置 ConsoleLiveView（TTY 实时刷新）；
 * serve 模式下再由 CLI 注入 WebLiveView（广播给 Web UI），实现「同一份增量、多端呈现」。
 */
export class CompositeLiveView implements ToolInputSink {
  /** 组合视图在 live 通道内的标识名。 */
  public readonly name = 'composite-live-view';
  private readonly sinks: ToolInputSink[] = [];

  public constructor(initial: readonly ToolInputSink[] = []) {
    this.sinks.push(...initial);
  }

  /**
   * 追加一个子实时视图（去重）。
   * @param sink 待追加的子视图（重复追加按首次为准）
   * @returns 无返回值。
   */
  public addSink(sink: ToolInputSink): void {
    if (!this.sinks.includes(sink)) this.sinks.push(sink);
  }

  /**
   * 移除一个子实时视图。
   * @param sink 待移除的子视图（不存在则静默）
   * @returns 无返回值。
   */
  public removeSink(sink: ToolInputSink): void {
    const idx = this.sinks.indexOf(sink);
    if (idx >= 0) this.sinks.splice(idx, 1);
  }

  /**
   * 工具输入增量广播：把同一份 delta 依序转发给全部子 sink。
   *
   * @param delta 工具输入增量事件
   
   * @returns 无返回值。
   */
  public onToolInput(delta: ToolInputDelta): void {
    for (const sink of this.sinks) sink.onToolInput(delta);
  }

  /**
   * 文本增量转发（V2.1）：仅转发给声明了该能力的子 sink。
   * @param text 模型文本增量
   * @returns 无返回值。
   */
  public onTextDelta(text: string): void {
    for (const sink of this.sinks) sink.onTextDelta?.(text);
  }
}
