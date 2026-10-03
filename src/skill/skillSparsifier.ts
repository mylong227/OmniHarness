/**
 * 技能稀疏化器（T5.4 · RLVR 训练信号 / 上下文噪声治理）。
 *
 * 解决的问题：技能「堆叠」——每次注入把全部命中技能都渲染进上下文，命中越多噪声越大，
 * 模型注意力被稀释，成功率反而下降。稀疏化按**命中强度**保留最有用的 top-k：
 * 名字精确命中 > 名字子串命中 > 标签命中；同分按名称字典序（确定性，无随机源）。
 *
 * 成功率不降的机制保障：名字命中级（score ≥ 3）的强命中**永不因预算截断被丢弃**
 * （fail-soft 下限 `minKeepScore`），被剪的只有标签级弱命中的长尾。
 *
 * @maturity L1 — 命中强度评分是显式规则（可逐项复算）；「噪声下降且强命中保留」由测试断言
 * @maturityEvidence tests/unit/skillSparsifier.test.ts
 */
import type { Skill } from './skill.js';

/** 稀疏化选项。 */
export interface SkillSparseOptions {
  /** 最多保留条数（默认 5；超出预算时按得分从低往高剪）。 */
  readonly maxSkills?: number;
  /** 强命中下限（默认 3 = 名字命中级）：得分 ≥ 此值的技能即使超出 top-k 也保留（fail-soft 下限）。 */
  readonly minKeepScore?: number;
}

/** 稀疏化结果（审计/回归对照用）。 */
export interface SparseResult {
  /** 保留的技能（按得分降序）。 */
  readonly kept: readonly Skill[];
  /** 被剪掉的技能（长尾）。 */
  readonly dropped: readonly Skill[];
  /** 每条技能的得分（kept ∪ dropped 与输入一一对应，键 = 技能名）。 */
  readonly scores: ReadonlyMap<string, number>;
}

/**
 * 技能稀疏化器：对「已命中技能 × 提示文本」做预算化取舍。
 * 无状态（同输入恒同结果），实例化以承载默认参数并保持 OO 一致性（D9：新代码禁顶层函数）。
 */
export class SkillSparsifier {
  /** 预算上限（默认 5）。 */
  private readonly maxSkills: number;
  /** 强命中下限（默认 3 = 名字命中级）。 */
  private readonly minKeepScore: number;

  /**
   * @param opts top-k 与强命中下限（缺省用默认值）
   */
  public constructor(opts: SkillSparseOptions = {}) {
    this.maxSkills = Math.max(1, Math.floor(opts.maxSkills ?? 5));
    this.minKeepScore = Math.max(0, opts.minKeepScore ?? 3);
  }

  /**
   * 对单条技能打命中强度分（确定性）。
   * @param skill 技能
   * @param textLower 小写化的提示文本
   * @returns 得分：名字精确等值 4；名字子串命中 3；标签命中 1（多标签累加，封顶 2）
   */
  public hitScore(skill: Skill, textLower: string): number {
    const name = skill.name.toLowerCase();
    if (textLower === name) return 4;
    if (textLower.includes(name)) return 3;
    const tagHits = (skill.tags ?? []).filter((tag) =>
      textLower.includes(tag.toLowerCase()),
    ).length;
    return Math.min(2, tagHits);
  }

  /**
   * 技能稀疏化：按命中强度降序保留 top-k；名字命中级（≥ minKeepScore）的强命中永不剪。
   * 语义：预算（maxSkills）约束弱命中长尾，强命中豁免——保证「有用技能不丢、噪声长尾被剪」。
   *
   * ## 两个判据要真的有语义，调用方必须传**未截断**的候选集（2026-10-03 修 §3-5）
   *
   * 旧生产路径是 `SkillRegistry.selectForPrompt()`（已截到 5 条）→ 本方法：预算判据
   * `kept.length < maxSkills` **恒真**、强命中豁免**永不生效**，且排序键（命中强度 → 名称）
   * 会把 BM25 相关性序整体覆盖成「按名称字典序」。现调用方改走
   * `SkillRegistry.rankForPrompt()`（比率过滤但**不截断**）+ 本方法的 `relevance` 主序：
   * 相关性决定取舍与顺序，命中强度只在相关性相同时分先后并触发豁免。
   * @param matched 已命中/已过滤的技能（**不得预先按 maxSkills 截断**，否则预算与豁免退化）
   * @param textLower 小写化的提示文本
   * @param relevance 上游相关性分（技能名 → 分，通常来自 BM25）。给了就作**主序**（降序）；
   *   未给则各条视作同分（退化为「只按命中强度 + 名称」的确定性顺序，与改造前逐字一致）。
   * @returns kept/dropped 与得分表
   */
  public sparsify(
    matched: readonly Skill[],
    textLower: string,
    relevance?: ReadonlyMap<string, number>,
  ): SparseResult {
    const scored = matched
      .map((skill) => ({
        skill,
        score: this.hitScore(skill, textLower),
        relevance: relevance?.get(skill.name) ?? 0,
      }))
      .sort(
        (a, b) =>
          b.relevance - a.relevance || b.score - a.score || (a.skill.name < b.skill.name ? -1 : 1),
      );

    const kept: Array<{ skill: Skill; score: number }> = [];
    const dropped: Array<{ skill: Skill; score: number }> = [];
    const scores = new Map<string, number>();
    for (const entry of scored) {
      scores.set(entry.skill.name, entry.score);
      // 保留判据（二者其一）：① 预算未满（按得分降序取 top-k）；② 强命中豁免（≥ minKeepScore，预算外也不剪）。
      const keep = kept.length < this.maxSkills || entry.score >= this.minKeepScore;
      (keep ? kept : dropped).push({ skill: entry.skill, score: entry.score });
    }

    return { kept: kept.map((k) => k.skill), dropped: dropped.map((d) => d.skill), scores };
  }
}
