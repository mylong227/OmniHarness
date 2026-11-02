import type { AuditRecordDraft } from './auditTypes.ts';

/** Codex 解析过程里的成本累计（`token_count` 给的是累计值，取最后一次覆盖）。 */
export interface CodexTokenState {
  /** 输入 token。 */
  prompt: number;
  /** 输出 token。 */
  completion: number;
  /** 缓存读 token。 */
  cached: number;
  /** 总 token。 */
  total: number;
  /** 是否见过用量事件。 */
  sawUsage: boolean;
}

/**
 * Codex 解析的**可变上下文**（解析器与两个写入协作者共享同一份）。
 *
 * 为什么单独一个类型：`response_item` 与 `event_msg` 两条支路都要往同一条时间线里写记录、
 * 共享"已见调用 id"与成本累计；把上下文抽出来后，两个写入类各自只有 <25 个方法，
 * 不再触发"上帝类"判据（`auditStandards --maturity`）。
 */
export interface CodexParseContext {
  /** 记录累加器（保序）。 */
  readonly records: AuditRecordDraft[];
  /** 已见到的调用 id（避免 event_msg 与 response_item 重复记工具）。 */
  readonly seenCalls: Set<string>;
  /** 是否出现过 `response_item` 消息（决定是否采用 event_msg 文本副本）。 */
  hasResponseMessages: boolean;
  /** 成本累计。 */
  readonly tokens: CodexTokenState;
}
