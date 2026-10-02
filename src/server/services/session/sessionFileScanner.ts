import { statSync } from 'node:fs';

// 会话存档的**逐行解析与文件度量**：JSONL 行 → 事件对象、文件 mtime。
//
// ## 为什么单独成文件
//
// 这两件事（坏行容错解析、mtime 兜底）与「会话服务」的业务语义（列表 / 改名 / 删除 / 归档 / 用量聚合）
// 无关，且被多处复用（用量聚合、列表扫描）。抽出来以后 `SessionArchive` 不再被这些细节撑成上帝类
// （编码标准门禁的「上帝类」闸），也让「坏行怎么办」这条口径只有一处定义。
//
// ## 坏行口径
//
// 空行 / 坏行 / 非对象一律返回 undefined：**调用方跳过该行继续**（能救多少救多少），而不是整份历史报废
// —— 一条坏行导致「静默空历史」是审计 §1.7 记录过的真实缺陷。

/** 解析出的事件形状（只取本服务关心的字段）。 */
export interface ParsedLine {
  /** 事件类型（缺失时为 undefined）。 */
  readonly type?: string;
  /** 事件时间戳（ISO 串）。 */
  readonly timestamp?: string;
  /** 载荷（对象）。 */
  readonly payload?: Record<string, unknown>;
}

/** 会话存档的行解析与文件度量工具。 */
export class SessionFileScanner {
  /**
   * 解析一行 JSONL；空行/坏行/非对象返回 undefined。
   * @param line 单行文本
   * @returns 解析出的事件对象；空行/坏行/非对象返回 undefined
   */
  public static parseLine(line: string): ParsedLine | undefined {
    if (line.trim() === '') return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      return undefined;
    }
    if (parsed === null || typeof parsed !== 'object') return undefined;
    const obj = parsed as Record<string, unknown>;
    const out: ParsedLine = {};
    if (typeof obj['type'] === 'string') (out as { type?: string }).type = obj['type'];
    if (typeof obj['timestamp'] === 'string') {
      (out as { timestamp?: string }).timestamp = obj['timestamp'];
    }
    const payload = obj['payload'];
    if (payload !== null && typeof payload === 'object') {
      (out as { payload?: Record<string, unknown> }).payload = payload as Record<string, unknown>;
    }
    return out;
  }

  /**
   * 文件 mtime（毫秒）；消失竞态回退 0。
   * @param file 文件路径
   * @returns mtime 毫秒；不可读返回 0
   */
  public static mtimeOf(file: string): number {
    try {
      return statSync(file).mtimeMs;
    } catch {
      return 0;
    }
  }
}
