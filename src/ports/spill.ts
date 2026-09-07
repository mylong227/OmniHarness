/** 外溢句柄：被移出模型上下文的完整内容的定位信息。 */
export interface SpillHandle {
  readonly id: string;
  readonly bytes: number;
}

/**
 * 外溢端口：把超大工具输出移出模型上下文，只留有界预览 + 定位符。
 * 全文落后端存储，模型可按需用 spill_read 取回，避免单次大输出撑爆上下文。
 */
export interface SpillPort {
  readonly name: string;
  /** 保存完整内容并返回定位句柄。 */
  spill(content: string, sessionId: string): Promise<SpillHandle>;
  /** 读回完整内容（不存在或 id 非法返回 undefined）。 */
  read(id: string): Promise<string | undefined>;
}
