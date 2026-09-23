import { TOOL_NAMES } from '../../ports/tool/toolNames.js';
import type { ModelOutput, ModelPort, ModelRequest } from '../../ports/model/model.js';

/** 演示用模型适配器：第一步返回工具调用，后续返回最终文本（无需 API Key）。 */
export class MockModel implements ModelPort {
  /** 适配器名，与端口契约一致：固定为 'mock'。 */
  public readonly name = 'mock';

  /** 已收到的 generate 调用次数（决定首次是否返回工具调用）。 */
  private callCount = 0;

  /** 生成响应。
   * @param request 模型请求（只读末条对话消息判定脚本走向，内容不参与生成）。
   * @returns 首次调用且末条非 system 消息为用户消息时返回 shell 工具调用脚本，否则返回固定的完成文本。
   */
  public async generate(request: ModelRequest): Promise<ModelOutput> {
    this.callCount += 1;
    if (this.shouldUseTool(request)) {
      return {
        toolCalls: [
          {
            id: 'mock_call_1',
            name: TOOL_NAMES.shell,
            arguments: { command: 'echo OmniHarness运行中' },
          },
        ],
      };
    }
    return { text: '任务完成（模拟模型适配器输出）' };
  }

  /** 首次请求且末条**非 system** 消息为用户消息时返回工具调用。
   *
   *  为什么忽略尾部的 system 消息：宿主的动态段（repo-map / 项目指令）会被注入成**尾部**
   *  system 消息（为前缀缓存命中而刻意置于尾部）。若按「最后一条消息必须是 user」判定，
   *  这些注入会让第一回合直接跳到「最终文本」，工具回路在真实装配下**根本走不到**
   *  （`npm run smoke` 的 A 段就是这么被证伪的：步数 1 而非 ≥2）。
   * @param request 模型请求。
   * @returns true 表示本次应输出工具调用（演示工具回路）；false 表示输出最终文本。
   */
  private shouldUseTool(request: ModelRequest): boolean {
    if (this.callCount !== 1) {
      return false;
    }
    const conversational = [...request.messages]
      .reverse()
      .find((message) => message.role !== 'system');
    return conversational !== undefined && conversational.role === 'user';
  }
}
