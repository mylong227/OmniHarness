/**
 * @beta
 * 可验证奖励的回放缓冲端口（绿样本进、策略更新/回放消费出）。
 *
 * 2026-10-27 从 `src/evolution/rlvrLoop.ts` 外迁至端口层，拆掉**环④ 进化回放组**：
 * `ReplayBuffer` 接口原先声明在实现文件 `rlvrLoop.ts` 里，而唯一实现 `inMemoryReplayBuffer.ts`
 * 必须 `import type` 它 ⇒ 形成 2 成员强连通分量（`rlvrLoop ↔ inMemoryReplayBuffer`）。
 * 类型本身不含实现，属端口层该有的东西（与同目录 `codeCandidate.ts` 2026-10-11 的外迁同型）；
 * 原位置改为导入 + 再导出，公开 API 面零改动。
 */
import type { CodeCandidate } from './codeCandidate.ts';

/** 回放缓冲：收集「绿」样本供后续策略更新。 */
export interface ReplayBuffer {
  /**
   * 追加一条绿样本。
   * @param candidate 通过可验证奖励筛选的代码候选。
   * @param reward 该候选的奖励得分（供后续策略更新/回放消费）。
   */
  push(candidate: CodeCandidate, reward: number): void;
  /** 当前缓冲条数。 */
  readonly size: number;
  /** 缓冲条目（候选 + 奖励；实现可按容量上限 FIFO 淘汰）。 */
  readonly entries: readonly { readonly candidate: CodeCandidate; readonly reward: number }[];
}
