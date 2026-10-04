/**
 * 晋升史服务（商业化路线图 **F2** 治理台的**数据面**）。
 *
 * ## 它回答什么
 *
 * F2 的判据原文是：「治理台展示的**每条晋升记录**都能用 `audit verify` **独立复核**通过
 * （**数据与证据同源**）」。本服务就是那个数据面：把台账条目逐行变成可展示的行，
 * 并为**每一行**给出独立复核结论。
 *
 * ## 「独立复核」在这里是什么意思（不是把台账自己的 verify 结果抄一遍）
 *
 * 台账的 `verify()` 给的是**整链**结论。治理台要的是**逐行可核**：
 * 于是本服务对每条条目**自行重算**该条目的哈希是否等于"用其 `prev` 与正文重算"的结果，
 * 并检查 `prev` 是否等于**上一条的 `hash`**（链式连接）。这样：
 *
 * - 台账 `verify()` 绿 ⇒ 每行必绿（一致）；
 * - 若台账被篡改而实现方"顺手"信任了 `verify()`，本服务的逐行重算会**独立**发现断链
 *   ——这条独立性由判据钉死（见 `promotionHistoryService.test.ts` 的变异用例）。
 *
 * ## 回滚入口（F2 的"一键回滚"）
 *
 * `rollbackTargets()` 列出**可回滚到的快照**（治理台据此渲染按钮）；真正的回滚仍走
 * `PromotionLedgerPort.rollback(seq)`（本服务**不**直接改盘——只提供入口与预览）。
 *
 * @maturity L1 — 逐行独立重算（篡改/断链/删行三类可检出）+ 快照锚点列表 判据钉死
 * @maturityEvidence tests/unit/promotionHistoryService.test.ts
 */
import type { PromotionLedgerEntry, PromotionLedgerPort } from '../ports/runtime/evolution.js';

/** 治理台要展示的一行（含**该行自己的**复核结论）。 */
export interface PromotionHistoryRow {
  /** 台账序号（治理台的行 id）。 */
  readonly seq: number;
  /** 时间戳（ISO）。 */
  readonly ts: string;
  /** 动作类型。 */
  readonly action: string;
  /** 晋升记录的资产名（非 promote 型条目为 undefined）。 */
  readonly name?: string | undefined;
  /** 溯源（如 `twist:a+b` / `pack:…`）。 */
  readonly source?: string | undefined;
  /** 回滚型条目指向的快照 seq。 */
  readonly rollbackTo?: number | undefined;
  /** 本条目的哈希。 */
  readonly hash: string;
  /** 上一条的哈希（链式连接）。 */
  readonly prev: string;
  /** **本行独立复核**：自算哈希匹配 **且** `prev` 接上上一条。 */
  readonly verified: boolean;
  /** 复核失败原因（`verified:true` 时为 undefined）。 */
  readonly reason?: string | undefined;
}

/** 可回滚到的快照锚点（治理台"一键回滚"的目标）。 */
export interface RollbackTarget {
  /** 快照条目 seq。 */
  readonly seq: number;
  /** 快照时间。 */
  readonly ts: string;
  /** 快照里的技能数（展示"回滚会到什么状态"）。 */
  readonly skillCount: number;
}

/** 晋升史快照（治理台一次拉取的全部内容）。 */
export interface PromotionHistoryView {
  /** 逐行历史（**注册序**，与台账一致）。 */
  readonly rows: readonly PromotionHistoryRow[];
  /** 独立复核汇总：通过行数 / 总行数 / 首个失败行（可行动）。 */
  readonly summary: {
    readonly total: number;
    readonly verified: number;
    readonly firstFailureSeq?: number | undefined;
  };
  /** 可回滚到的快照锚点（时间倒序，最近的在最前）。 */
  readonly rollbackTargets: readonly RollbackTarget[];
}

/** 晋升史服务：台账 → 治理台视图（**只读**）。 */
export class PromotionHistoryService {
  /**
   * 台账创世 `prev`（**全零 64 位十六进制**，与 `HashChain` 的初值一致）。
   *
   * 为什么不写 `''` / `'genesis'`：真实台账用的是全零哨兵；猜错会把**健康台账的首行**判成断链——
   * 治理台"喊狼来了"比不报更糟（第一版就是这么错的，判据当场红）。
   */
  private static readonly GENESIS_PREV = '0'.repeat(64);

  /**
   * @param ledger 晋升台账（唯一数据源；本服务不自己读盘）
   * @param hashOf 台账口径的哈希函数（由台账公开提供，避免本文件复制一份口径）
   */
  public constructor(
    private readonly ledger: PromotionLedgerPort,
    private readonly hashOf: (entry: PromotionLedgerEntry) => string,
  ) {}

  /**
   * 取治理台视图：逐行独立复核 + 快照锚点。
   * @returns 视图（确定性：同一台账内容恒同输出）
   */
  public view(): PromotionHistoryView {
    const entries = this.ledger.list();
    const rows = entries.map((entry, index) => this.rowOf(entry, entries[index - 1]));
    const firstFailure = rows.find((row) => !row.verified);
    return {
      rows,
      summary: {
        total: rows.length,
        verified: rows.filter((row) => row.verified).length,
        ...(firstFailure !== undefined ? { firstFailureSeq: firstFailure.seq } : {}),
      },
      rollbackTargets: PromotionHistoryService.targetsOf(entries),
    };
  }

  /**
   * 逐行独立复核：**自算**该条目的哈希与链式连接（不抄台账的整链结论）。
   * @param entry 台账条目
   * @param previous 上一条（首条为 undefined）
   * @returns 展示行
   */
  private rowOf(
    entry: PromotionLedgerEntry,
    previous: PromotionLedgerEntry | undefined,
  ): PromotionHistoryRow {
    const chainOk =
      previous === undefined
        ? entry.prev === PromotionHistoryService.GENESIS_PREV
        : entry.prev === previous.hash;
    const recomputed = this.hashOf(entry);
    const hashOk = recomputed === entry.hash;
    const verified = chainOk && hashOk;
    const reason = verified
      ? undefined
      : !hashOk
        ? `第 ${String(entry.seq)} 条自算哈希与记录不符（正文被改）`
        : `第 ${String(entry.seq)} 条 prev 未接上上一条（断链或删行）`;
    return {
      seq: entry.seq,
      ts: entry.ts,
      action: entry.action ?? 'promote',
      ...(entry.promoted !== undefined
        ? { name: entry.promoted.name, source: entry.promoted.source }
        : {}),
      ...(entry.rollbackTo !== undefined ? { rollbackTo: entry.rollbackTo } : {}),
      hash: entry.hash,
      prev: entry.prev,
      verified,
      ...(reason !== undefined ? { reason } : {}),
    };
  }

  /**
   * 取快照锚点（时间倒序：治理台把最近的放最前）。
   * @param entries 台账条目
   * @returns 锚点列表
   */
  private static targetsOf(entries: readonly PromotionLedgerEntry[]): readonly RollbackTarget[] {
    return entries
      .filter((entry) => entry.action === 'snapshot')
      .map((entry) => ({
        seq: entry.seq,
        ts: entry.ts,
        skillCount: entry.skills?.length ?? 0,
      }))
      .reverse();
  }
}
