import type { ModelMessage } from '../ports/model/model.js';

/**
 * 规整消息序列中的工具调用/响应配对，确保 OpenAI/DeepSeek 兼容 API 不再因
 * 协议校验返回 HTTP 400。OpenAI 的实际规则（按消息出现顺序）共有两条强约束：
 *
 * 1. `role:'tool'` 必须**紧邻**前序 `assistant.tool_calls` 中某条 id 的响应；
 *    且前序 assistant 必须存在对应 `tool_calls.id`。
 * 2. 任何带 `tool_calls` 的 assistant 消息之后，必须**紧邻**该轮所有
 *    `tool_call_id` 的 tool 响应，缺一不可。
 *
 * 历史教训（#OBS-8，2026-09-08 二次复现）：
 *  - v33 走"全局存在"——仍会触发 400（partial response）。
 *  - v34 走"丢整段"——太狠，把含 reasoning / text 的整段 assistant 全丢，
 *    模型失去上文而死循环调工具不产文（hasText:false）。
 *  - v35（当前）：走"最低破坏"——从 assistant.toolCalls 移除未响应的 id，
 *    丢弃未被任何 assistant 紧邻认领的 orphan tool 消息。assistant 本体
 *    （含 reasoning_content / content）始终保留，OpenAI 校验也满足。
 *
 * 计算合法 toolCallId 集合的算法：
 *   顺序扫到 assistant+toolCalls 时，收集紧邻（中间无 user/system、id 属于
 *   本轮）的 tool 响应 id；这些 id 才是合法的。其它 id 视为"被切走"或
 *   "id 不匹配"，在 rebuild 阶段被从 assistant.toolCalls 中过滤掉。
 */
export function sanitizeToolRounds(messages: readonly ModelMessage[]): ModelMessage[] {
  // 1) 收集"合法 toolCallId"：必须紧邻某 assistant.tool_calls 出现
  const validIds = new Set<string>();
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role !== 'assistant' || m.toolCalls === undefined || m.toolCalls.length === 0) continue;
    const expected = new Set(m.toolCalls.map((tc) => tc.id));
    for (let j = i + 1; j < messages.length; j++) {
      const t = messages[j]!;
      if (t.role !== 'tool' || t.toolCallId === undefined) break;
      if (!expected.has(t.toolCallId)) break;
      if (validIds.has(t.toolCallId)) break; // id 在协议上必须唯一，重复即终止本轮
      validIds.add(t.toolCallId);
    }
  }

  // 2) 重建消息：tool 消息仅保留合法 id；assistant 仅保留合法 toolCalls。
  const out: ModelMessage[] = [];
  for (const m of messages) {
    if (m.role === 'tool') {
      if (m.toolCallId !== undefined && validIds.has(m.toolCallId)) out.push(m);
      // 孤儿 tool：无 id 或 id 未被任何 assistant 紧邻认领 → 直接丢弃
      continue;
    }
    if (m.role === 'assistant' && m.toolCalls !== undefined && m.toolCalls.length > 0) {
      const kept = m.toolCalls.filter((tc) => validIds.has(tc.id));
      if (kept.length === m.toolCalls.length) {
        out.push(m);
      } else if (kept.length > 0) {
        out.push({ ...m, toolCalls: kept });
      } else {
        // 该 assistant 的所有 toolCall 都缺响应，但 assistant 仍含 reasoning/text，
        // 保留本体（去掉 toolCalls 字段），避免下游判定"assistant with tool_calls"触发
        // "insufficient tool messages" 校验。
        out.push({ ...m, toolCalls: undefined });
      }
      continue;
    }
    out.push(m);
  }
  return out;
}
