import type { ToolInputDelta } from '../../ports/model.js';
import type { ToolInputSink } from '../../ports/toolInputSink.js';

/**
 * @beta
 * 实时广播通道最小接口（由 HttpBridgeTransport 提供；解耦 web 适配器与具体传输实现）。
 */
export interface LiveBroadcaster {
  /** 向全部已连接客户端广播一条通知（SSE / WS）。 */
  notify(method: string, params: Record<string, unknown>): void;
}

/**
 * @beta
 * Web 实时视图（#B3 web）：把工具参数增量经广播通道推给 Web UI。
 *
 * 前端经 SSE / WS 收到 `method = thread.tool_input` 的通知后，渐进渲染对应工具卡片的参数，
 * 让用户在模型「思考出参数」的过程中即看到 JSON 逐字符增长（而非等工具执行完才一次性出现）。
 */
export class WebLiveView implements ToolInputSink {
  public readonly name = 'web-live-view';

  public constructor(private readonly broadcaster: LiveBroadcaster) {}

  public onToolInput(delta: ToolInputDelta): void {
    this.broadcaster.notify('thread.tool_input', {
      id: delta.id ?? null,
      name: delta.name ?? null,
      partialJson: delta.partialJson,
    });
  }
}
