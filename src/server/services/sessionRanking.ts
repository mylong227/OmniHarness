// 会话排序（v2）：显式名次 + 「新会话置顶」+ 「历史垫后」三层模型。
//
// 见 SessionRanking 的类注释（为什么 v1 数组在跨客户端下会把新会话丢到列表底部）。
// 纯计算、零 IO：可直接单测（见 tests/unit/sessionRanking.test.ts）。

/** 排序侧车文档（v2）：显式名次表 + 最后一次排序的时刻。 */
export interface OrderDoc {
  /** `sessionId → 显式名次`（越大越靠后；提交过的会话才有）。 */
  readonly rank: Record<string, number>;
  /** 最后一次用户排序的时刻（毫秒）：此后新出现的会话视为「新的」，排在显式顺序之前。 */
  readonly at: number;
}

/** 空排序文档。 */
const EMPTY_ORDER: OrderDoc = { rank: {}, at: 0 };

/**
 * 会话排序规则：**显式名次 + 「新会话置顶」**，从而跨客户端也成立。
 *
 * ## 为什么需要它（2026-09-27 用户点名「另一个客户端新建的会话仍被排在已登记项之后」）
 *
 * v1 只存了一个 id 数组，语义是「登记过的按数组顺序在前、未登记的按时间倒序垫后」。这在**单客户端**
 * 下没问题，但另一个客户端刚建的会话会被当成「未登记」而垫到最后 —— 用户刚聊过的会话跑到列表底部。
 *
 * v2 用**三层**：
 * 1. **新会话层**（`mtime > at`，即上次排序之后出现的）：按时间倒序，排在最前 —— 「刚建的在最上面」；
 * 2. **显式顺序层**（有名次）：按名次升序 —— 用户排过的位置不被新会话顶掉；
 * 3. **历史未登记层**（`mtime <= at` 且无名次）：按时间倒序垫后 —— 升级前的几百个老会话不会挤到前面。
 *
 * 纯计算、可单测（见 tests/unit/sessionRanking.test.ts）。
 */
export class SessionRanking {
  /**
   * 把 v1（`string[]`）或 v2（`{rank, at}`）侧车内容解析成 v2 文档。
   * @param parsed 侧车原始 JSON（`unknown`）
   * @returns 排序文档；无法识别时为空文档
   */
  public static parse(parsed: unknown): OrderDoc {
    if (Array.isArray(parsed)) {
      // v1 兼容：数组下标即名次；`at = 0` ⇒ 所有会话都算「历史未登记」（不凭空把它们提到最前）。
      const rank: Record<string, number> = {};
      parsed.forEach((id, i) => {
        if (typeof id === 'string') rank[id] = i;
      });
      return { rank, at: 0 };
    }
    if (parsed !== null && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;
      const raw = obj['rank'];
      const rank: Record<string, number> = {};
      if (raw !== null && typeof raw === 'object') {
        for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
          if (typeof v === 'number' && Number.isFinite(v)) rank[id] = v;
        }
      }
      const at = typeof obj['at'] === 'number' && Number.isFinite(obj['at']) ? obj['at'] : 0;
      return { rank, at };
    }
    return EMPTY_ORDER;
  }

  /**
   * 取排序键（`[层, 层内序]`，升序即列表顺序）。
   * @param rank 该会话的显式名次（无则 undefined）
   * @param mtimeMs 文件 mtime（新会话判定与层内倒序都用它）
   * @param at 上次排序时刻
   * @returns 排序键
   */
  public static sortKey(
    rank: number | undefined,
    mtimeMs: number,
    at: number,
  ): readonly [number, number] {
    if (rank !== undefined) return [1, rank];
    if (mtimeMs > at) return [0, -mtimeMs]; // 新会话：时间倒序（最新在最前）
    return [2, -mtimeMs];
  }

  /**
   * 比较两个排序键。
   * @param a 键 a
   * @param b 键 b
   * @returns 负数表示 a 在前
   */
  public static compare(a: readonly [number, number], b: readonly [number, number]): number {
    return a[0] !== b[0] ? a[0] - b[0] : a[1] - b[1];
  }

  /**
   * 生成新的排序文档：提交的 id 按提交顺序取稠密名次 `0..n-1`，**未提交但已登记**的会话保持相对
   * 顺序排在其后（并发场景下别的客户端排过的位置不被清掉），并把 `at` 推进到当前时刻。
   * @param submitted 本次提交的有序 id
   * @param prev 现有文档
   * @param now 当前时刻（毫秒；单测注入）
   * @returns 新文档
   */
  public static densify(submitted: readonly string[], prev: OrderDoc, now: number): OrderDoc {
    const rank: Record<string, number> = {};
    const seen = new Set<string>();
    let next = 0;
    for (const id of submitted) {
      if (seen.has(id)) continue;
      seen.add(id);
      rank[id] = next++;
    }
    // 未提交但有名次的：按原名次升序接在后面（保序、不丢）。
    const rest = Object.keys(prev.rank)
      .filter((id) => !seen.has(id))
      .sort((a, b) => (prev.rank[a] ?? 0) - (prev.rank[b] ?? 0));
    for (const id of rest) rank[id] = next++;
    return { rank, at: now };
  }
}
