import type { ModelOutput, ModelPort, ModelRequest } from '../../ports/model.js';

/** 演示用模型适配器：第一步返回工具调用，后续返回最终文本（无需 API Key）。 */
export class MockModel implements ModelPort {
  /** 适配器名，与端口契约一致：固定为 'mock'。 */
  public readonly name = 'mock';

  /** 已收到的 generate 调用次数（决定首次是否返回工具调用）。 */
  private callCount = 0;

  /** 生成响应。
   * @param request 模型请求（只读末条消息判定脚本走向，内容不参与生成）。
   * @returns 首次调用且末条为用户消息时返回 shell 工具调用脚本，否则返回固定的完成文本。
   */
  public async generate(request: ModelRequest): Promise<ModelOutput> {
    this.callCount += 1;
    if (this.shouldUseTool(request)) {
      return {
        toolCalls: [
          { id: 'mock_call_1', name: 'shell', arguments: { command: 'echo OmniHarness运行中' } },
        ],
      };
    }
    return { text: '任务完成（模拟模型适配器输出）' };
  }

  /** 首次请求且末条为用户消息时返回工具调用。
   * @param request 模型请求。
   * @returns true 表示本次应输出工具调用（演示工具回路）；false 表示输出最终文本。
   */
  private shouldUseTool(request: ModelRequest): boolean {
    const last = request.messages.at(-1);
    return this.callCount === 1 && last !== undefined && last.role === 'user';
  }
}
