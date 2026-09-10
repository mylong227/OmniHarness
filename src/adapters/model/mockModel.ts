import type { ModelOutput, ModelPort, ModelRequest } from '../../ports/model.js';

/** 演示用模型适配器：第一步返回工具调用，后续返回最终文本（无需 API Key）。 */
export class MockModel implements ModelPort {
  public readonly name = 'mock';

  private callCount = 0;

  /** 生成响应。 */
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

  /** 首次请求且末条为用户消息时返回工具调用。 */
  private shouldUseTool(request: ModelRequest): boolean {
    const last = request.messages.at(-1);
    return this.callCount === 1 && last !== undefined && last.role === 'user';
  }
}
