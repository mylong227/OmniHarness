import type { Skill } from '../../../skill/skill.js';

/**
 * 台账条目动作。
 *
 * - `snapshot`：晋升前全量快照；`promote`：晋升；`rollback`：回滚（Wave A 三型）；
 * - `governance`：**资产治理状态变更**（信任档/隔离档/生命周期，Wave B ADR-0009）——
 *   与 `promote` 同链但语义不同：「生效了什么」不等于「改了什么档位」，混记会让追责读不出来；
 * - `pack-install`：**签名资产包安装**（Wave D ADR-0011）——外来资产的入册事件，逐资产一条
 *   （Ω-2：任何资产变更 = 链上一个条目）。
 */
export type PromotionLedgerAction =
  'snapshot' | 'promote' | 'rollback' | 'governance' | 'pack-install';

/**
 * 晋升台账条目（哈希链一环）。
 *
 * 链算法与遥测/审计链同源（`util/hashChain`：`hash_n = SHA256(prev_n ‖ sep ‖ canonical_n)`），
 * 但**语义独立**：台账记的是「技能表状态变化」的操作史（快照/晋升/回滚），
 * 不是「人/系统动作」的证据链——两者混用会让追责与还原互相污染（ADR-0008）。
 */
export interface PromotionLedgerEntry {
  /** 链序号（从 1 递增）。 */
  readonly seq: number;
  /** ISO 时间戳。 */
  readonly ts: string;
  /** 条目动作。 */
  readonly action: PromotionLedgerAction;
  /** snapshot：快照时的**全量**技能表；rollback：还原目标表；promote：空。 */
  readonly skills?: readonly Skill[] | undefined;
  /** promote：被晋升的技能名与来源。 */
  readonly promoted?: { readonly name: string; readonly source: string } | undefined;
  /** rollback：被还原到的快照 seq。 */
  readonly rollbackTo?: number | undefined;
  /** 上一条哈希（首条为 GENESIS 全零）。 */
  readonly prev: string;
  /** 本条哈希。 */
  readonly hash: string;
}

/** 晋升记录（`append` 的输入；链字段由台账自持）。 */
export interface PromotionRecord {
  /** 被晋升的技能名。 */
  readonly name: string;
  /** 晋升来源（候选 `source`，如 `twist:a+b`；治理变更写 `governance:<state>`）。 */
  readonly source: string;
  /** ISO 时间戳（可选，缺省由台账生成）。 */
  readonly ts?: string | undefined;
  /**
   * 条目动作（缺省 `promote`，Wave A 口径逐字不变）。
   *
   * 加这个字段而**不改链的规范化形状**：动作本就参与哈希（`canonicalOf` 的 `action`），
   * 故新动作不需要新字段，既有链的哈希空间**逐字节不变**（老文件仍可验签）。
   */
  readonly action?: 'promote' | 'governance' | 'pack-install' | undefined;
}

/** 还原计划：`rollback(seq)` 的产出（**不直接改注册表**——apply 由组合根注入的回调执行）。 */
export interface SkillRestorePlan {
  /** 被还原到的快照 seq。 */
  readonly seq: number;
  /** 目标技能表（快照的全量深副本；apply 者据此与当前表 diff：表内 replace、多出者移除）。 */
  readonly skills: readonly Skill[];
}

/** 台账链完整性报告（语义同 `TelemetryChainReport`，但本链无「旧格式」态：恒可验证）。 */
export interface PromotionLedgerVerifyReport {
  /** 链完整性：true = 完整；false = 被篡改（含中间条目被改/删）。 */
  readonly ok: boolean;
  /** 参与校验的条目数。 */
  readonly count: number;
  /** 首个断裂处 seq（ok=false 时有值）。 */
  readonly brokenAt?: number | undefined;
  /** 断裂原因（ok=false 时有值）。 */
  readonly reason?: string | undefined;
}

/**
 * 晋升台账端口（GEE Kernel ⑤ snapshotBefore 环 + 第七环「回滚」的存储面）。
 *
 * 治理不变式（ADR-0008 / 目标架构 S3）：**无快照不晋升**——晋升前必须先落快照，
 * 台账因此把「系统变成了什么样」与「账上记了什么」钉成恒等（UCE 公理 Ω-2）。
 *
 * 实现须：append-only（已落条目永不改写）、哈希链防篡改、确定性（同操作序列恒同链）。
 */
export interface PromotionLedgerPort {
  /**
   * 晋升前快照：把当前技能表**全量**入链（深拷贝，此后外部改动不影响快照）。
   * @param skills 当前技能表（如 `SkillPort.list()`）
   * @returns 该快照条目的 seq（回滚时的定位锚点）
   */
  snapshotBefore(skills: readonly Skill[]): number;
  /**
   * 追加晋升记录。
   * @param promotion 晋升记录（技能名 + 来源）
   * @returns 该条目的 seq
   */
  append(promotion: PromotionRecord): number;
  /**
   * 还原到指定快照：定位 `seq` 处（或其之前最近）的 snapshot 条目，产出还原计划，
   * 并把本次回滚本身作为 `rollback` 条目入链（治理事件不隐身）。
   * @param seq 回滚目标快照的 seq
   * @returns 还原计划（目标技能表全量深副本）
   * @throws 定位不到快照（seq 非法 / 链中无 snapshot）时抛错（fail-closed，绝不静默空还原）
   */
  rollback(seq: number): SkillRestorePlan;
  /**
   * 链完整性校验（重算全链哈希比对）。
   * @returns 完整性报告
   */
  verify(): PromotionLedgerVerifyReport;
  /**
   * 列出全部条目（**注册序**）。
   *
   * 为什么要进端口：治理台（F2）必须**逐行**展示并能**独立复核**每条记录——只有整链
   * `verify()` 的结论抄不动这件事（"第几条坏了"是运维第一问）。清单是只读面，
   * 不含写入语义，故与 `verify()` 同层。
   * @returns 台账条目（只读；实现须回传副本，调用方改动不得影响台账内部状态）
   */
  list(): readonly PromotionLedgerEntry[];
}
