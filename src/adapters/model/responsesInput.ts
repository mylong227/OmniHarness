import type { ModelMessage } from '../../ports/model/model.ts';

/**
 * Responses API 的历史项序列化（2026-10-21 从 `ResponsesModel.splitSystem` 拆出）。
 *
 * 为什么单独成类：`ResponsesModel` 已贴着「上帝类」门禁（方法数 / 代码行数），而工具轮
 * 的序列化规则（`function_call` / `function_call_output`）与响应解析是两件事。抽出来后
 * 适配器只负责「发什么」，这里负责「历史长什么样」。
 *
 * 协议要点：Responses 的 `input` 没有 `role:'tool'`。模型发起的调用要回传为
 * `{type:'function_call', call_id, name, arguments}`，工具结果回传为
 * `{type:'function_call_output', call_id, output}`；两者用 `call_id` 配对。
 */
export class ResponsesInput {
  /**
   * 单条统一消息 → 一个或多个 Responses `input` 项。
   *
   * assistant 文本与工具调用拆成多个项：文本消息在前，随后是每个 `function_call`，
   * 顺序与模型实际输出一致。缺 `callId` 的畸形 tool 历史退成普通 user 文本，
   * 绝不发一个 `call_id` 为空的非法项。
   * @param message 统一消息。
   * @returns Responses input 项（至少一个）。
   */
  public static itemsOf(message: ModelMessage): readonly unknown[] {
    if (message.role === 'tool') {
      if (message.toolCallId === undefined || message.toolCallId === '') {
        return [{ role: 'user', content: message.content }];
      }
      return [
        { type: 'function_call_output', call_id: message.toolCallId, output: message.content },
      ];
    }
    if (message.role === 'assistant' && (message.toolCalls?.length ?? 0) > 0) {
      const items: unknown[] = [];
      if (message.content !== '') {
        items.push({ role: 'assistant', content: message.content });
      }
      for (const call of message.toolCalls ?? []) {
        items.push({
          type: 'function_call',
          call_id: call.id,
          name: call.name,
          arguments: JSON.stringify(call.arguments),
        });
      }
      return items;
    }
    return [{ role: message.role, content: message.content }];
  }
}
