import type { ModelMessage } from '../../ports/model/model.ts';

/**
 * Anthropic 扩展思考块的解析与回传（2026-10-29，E2）。
 *
 * 从 `AnthropicModel` 抽出（该类已到体量阈值）：只处理「thinking 文本 + signature」这一对，
 * 不碰网络与消息顺序。签名必须原样回传，否则多轮思考 + 工具会 400/降质。
 */
export class AnthropicThinking {
  /**
   * 从响应 content 块中取 thinking 文本与最后一个 signature。
   * @param content wire 层 content 块（只读）。
   * @returns `{thinking, signature}`；无 thinking 块时两者均缺省。
   */
  public static parse(
    content: readonly {
      readonly type: string;
      readonly thinking?: string;
      readonly signature?: string;
    }[],
  ): { readonly thinking?: string | undefined; readonly signature?: string | undefined } {
    const blocks = content.filter((block) => block.type === 'thinking');
    const thinking = blocks.map((block) => block.thinking ?? '').join('');
    const signature = blocks
      .map((block) => block.signature)
      .filter((value): value is string => typeof value === 'string' && value !== '')
      .at(-1);
    return {
      ...(thinking === '' ? {} : { thinking }),
      ...(signature === undefined ? {} : { signature }),
    };
  }

  /**
   * 把带签名的助手消息转成 Anthropic `thinking` + `text` 块。
   * @param message 统一消息。
   * @returns 块数组；无签名或无可回传内容时为 undefined（调用方走原字符串路径）。
   */
  public static wireBlocks(message: ModelMessage): Record<string, unknown>[] | undefined {
    if (
      message.role !== 'assistant' ||
      message.reasoningSignature === undefined ||
      message.reasoningSignature === ''
    ) {
      return undefined;
    }
    const blocks: Record<string, unknown>[] = [];
    if (message.reasoningContent !== undefined && message.reasoningContent !== '') {
      blocks.push({
        type: 'thinking',
        thinking: message.reasoningContent,
        signature: message.reasoningSignature,
      });
    }
    if (message.content !== '') {
      blocks.push({ type: 'text', text: message.content });
    }
    return blocks.length === 0 ? undefined : blocks;
  }
}
