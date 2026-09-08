import type { ModelMessage } from '../ports/model.js';

/**
 * 规整消息序列中的工具调用/响应配对，确保 OpenAI/DeepSeek 兼容 API 不再因
 * 协议校验返回 HTTP 400。OpenAI 的实际规则（按消息出现顺序）共有两条强约束：
 *
 * 1. `role:'tool'` 必须**紧邻**前序 `assistant.tool_calls` 中某条 id 的响应；
 *    且前序 assistant 必须存在对应 `tool_calls.id`。
 * 2. 任何带 `tool_calls` 的 assistant 消息之后，必须**紧邻**该轮所有
 *    `tool_call_id` 的 tool 响应，缺一不可。
 *
 * 历史上 OBS-7（reasoning_content）、OBS-8（orphan tool）都属此类，本工具
 * 一并覆盖：
 *  - 切到 compactor 时把部分响应切到 head 的"残缺 assistant" → 整段丢弃；
 *  - tail 起点无前置调用的"orphan tool" → 直接丢弃；
 *  - assistant 后面被 user/system 隔断的 tool 响应 → 视为对后续 assistant 无效。
 *
 * 注意：本工具只做"规整"——丢弃不合法段，不再尝试重构或拆分。
 */
export function sanitizeToolRounds(messages: readonly ModelMessage[]): ModelMessage[] {
  const out: ModelMessage[] = [];
  let i = 0;
  while (i < messages.length) {
    const m = messages[i]!;
    if (m.role === 'tool') {
      // 孤儿 tool：无前序 assistant.tool_calls 认领，整条丢弃
      i++;
      continue;
    }
    if (m.role === 'assistant' && m.toolCalls !== undefined && m.toolCalls.length > 0) {
      const expected = new Set(m.toolCalls.map((tc) => tc.id));
      // 紧邻的 tool 响应（中间不能出现非 tool 角色，且 toolCallId 必须属于本轮）
      let j = i + 1;
      const received = new Set<string>();
      while (j < messages.length) {
        const t = messages[j]!;
        if (t.role !== 'tool' || t.toolCallId === undefined) break;
        if (!expected.has(t.toolCallId)) break;
        received.add(t.toolCallId);
        j++;
      }
      if (received.size === expected.size) {
        out.push(m);
        for (let k = i + 1; k < j; k++) out.push(messages[k]!);
      }
      // 否则整段丢弃：assistant + 它声明的所有响应一起跳过（i 推进到 j）。
      i = j;
      continue;
    }
    out.push(m);
    i++;
  }
  return out;
}
