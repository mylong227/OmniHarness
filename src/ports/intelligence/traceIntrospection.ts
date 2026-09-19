/**
 * 只读自省 trace 端口（T4.5 · H5 · Harness Engineering）。
 *
 * 解决的问题：agent 想自查「我刚做了什么」时，唯一渠道是写通道（事件日志/记录器），
 * 既是写口又是读口——agent 一次误操作就能污染自己的历史。本端口把「读 trace」收成
 * **纯只读面**：实现方保证返回深拷贝/冻结快照，调用方（agent 工具、自评器）无法借道修改。
 *
 * 可复现消费：条目带稳定 seq 与 ISO 时间，同过滤条件恒同结果（事件流不重排）。
 */
/** 一条只读 trace 条目。 */
export interface TraceEntry {
  /** 稳定序号（事件流内单调，重放定位用）。 */
  readonly seq: number;
  /** 事件时刻（ISO 8601）。 */
  readonly at: string;
  /** 事件类别（tool.call / turn.end / error 等发布方语义）。 */
  readonly kind: string;
  /** 单行摘要（人类可读，供 agent 自省与报告）。 */
  readonly summary: string;
}

/**
 * trace 读取过滤器（RPC 与 CLI 共用同一形状，保证两条入口语义一致）。
 */
export interface TraceFilter {
  /** 返回条数上限（缺省 20；实现侧钳到 [1, 500]）。 */
  readonly limit?: number | undefined;
  /** 事件类别过滤（缺省不过滤，即 recent 语义）。 */
  readonly kind?: string | undefined;
}

/**
 * trace 读取查询（会话 + 过滤条件）。
 */
export interface TraceReadRequest extends TraceFilter {
  /** 目标会话 id（必填；空串表示「当前/最近会话」由实现方决定，缺省实现按未找到处理）。 */
  readonly session: string;
}

/**
 * trace 读取结果：只读条目 + 计数 + 失败原因（fail-soft，不抛错给调用方）。
 */
export interface TraceReadResult {
  /** 目标会话 id（原样回显，便于多会话消费方对齐）。 */
  readonly session: string;
  /** 冻结的条目快照（新在前）。 */
  readonly entries: readonly TraceEntry[];
  /** 条目数（= entries.length，便于 RPC 消费方免解析）。 */
  readonly count: number;
  /** 失败原因（会话不存在 / 存档不可读等）；成功时 undefined。 */
  readonly error?: string | undefined;
}

/** 只读自省 trace 端口（无任何写方法）。 */
export interface TraceIntrospectionPort {
  readonly name: string;
  /**
   * 最近 k 条（新在前）。
   * @param k 返回条数上限（默认 20）
   * @returns 冻结的条目快照（深拷贝，调用方改动不影响源）
   */
  recent(k?: number): readonly TraceEntry[];
  /**
   * 按类别取最近 k 条（新在前）。
   * @param kind 事件类别
   * @param k 返回条数上限（默认 20）
   * @returns 冻结的条目快照
   */
  byKind(kind: string, k?: number): readonly TraceEntry[];
}
