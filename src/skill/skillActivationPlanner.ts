/**
 * 技能激活规划器（2026-10-25，多 Skill 并发治理）。
 *
 * 解决三个真实问题：
 *  - **重复注入**：两个技能渲染出同一段文本（或同义模板）时只保留一份；
 *  - **上下文预算**：多条技能同时命中会线性放大 system token，按总字符预算裁剪弱项；
 *  - **潜在冲突**：tag 高度重叠意味着两个技能覆盖同一能力域，记录冲突供 UI/日志观测
 *    （不擅自删除——删除可能造成能力缺口，交由上层策略决定）。
 *
 * 纯逻辑、确定性排序（相关性 → 名称），可在 node:test 直接跑。
 */
import type { Skill } from './skill.ts';
import { BudgetedKnapsack } from '../util/budgetedKnapsack.ts';

/** 规划输入。 */
export interface SkillActivationCandidate {
  readonly skill: Skill;
  /** 已渲染的注入文本。 */
  readonly rendered: string;
  /** 上游相关性分（用于预算取舍与稳定排序）。 */
  readonly relevance: number;
}

/** 冲突记录。 */
export interface SkillConflict {
  readonly a: string;
  readonly b: string;
  /** tag Jaccard 相似度（无 tag 为 0）。 */
  readonly overlap: number;
  /** 共享的独占资源（无则空数组）。 */
  readonly resources: readonly string[];
}

/** 规划结果。 */
export interface SkillActivationPlan {
  readonly kept: readonly SkillActivationCandidate[];
  readonly dropped: readonly SkillActivationCandidate[];
  readonly conflicts: readonly SkillConflict[];
  /** 去重/预算命中次数（观测用）。 */
  readonly duplicates: number;
}

/** 默认总字符预算（约 3k token；5 条技能通常远低于此）。 */
const DEFAULT_MAX_CHARS = 12_000;

/** 技能激活规划器。 */
export class SkillActivationPlanner {
  /**
   * @param maxChars 注入文本总字符预算（≥1）。
   */
  public constructor(private readonly maxChars = DEFAULT_MAX_CHARS) {}

  /**
   * 规划本轮实际注入的技能。
   * @param candidates 已按相关性排序的候选（调用方保证顺序；本类会再稳定排序）。
   * @returns 保留/丢弃/冲突与去重计数。
   */
  public plan(candidates: readonly SkillActivationCandidate[]): SkillActivationPlan {
    const sorted = [...candidates].sort(
      (a, b) => b.relevance - a.relevance || (a.skill.name < b.skill.name ? -1 : 1),
    );
    const eligible: SkillActivationCandidate[] = [];
    const dropped: SkillActivationCandidate[] = [];
    const seen = new Set<string>();
    const reserved: SkillActivationCandidate[] = [];
    const resourceConflicts: SkillConflict[] = [];
    let duplicates = 0;
    for (const candidate of sorted) {
      const normalized = SkillActivationPlanner.normalize(candidate.rendered);
      if (seen.has(normalized)) {
        duplicates += 1;
        dropped.push(candidate);
        continue;
      }
      // 独占资源：与已保留的 exclusive 技能共享资源时，保留相关性更高者。
      if (candidate.skill.exclusive === true) {
        const conflict = reserved.find(
          (entry) =>
            entry.skill.exclusive === true &&
            SkillActivationPlanner.sharedResources(entry.skill, candidate.skill).length > 0,
        );
        if (conflict !== undefined) {
          resourceConflicts.push({
            a: conflict.skill.name,
            b: candidate.skill.name,
            overlap: SkillActivationPlanner.tagOverlap(conflict.skill, candidate.skill),
            resources: SkillActivationPlanner.sharedResources(conflict.skill, candidate.skill),
          });
          dropped.push(candidate);
          continue;
        }
        reserved.push(candidate);
      }
      seen.add(normalized);
      eligible.push(candidate);
    }
    // 预算内精确 0/1 背包：不因「先遇到贵项」而错失总价值更高的组合。
    const selection = BudgetedKnapsack.select(
      eligible.map((entry) => ({
        id: entry.skill.name,
        weight: SkillActivationPlanner.normalize(entry.rendered).length,
        value: entry.relevance,
      })),
      this.maxChars,
      true,
    );
    const selected = new Set(selection.indices);
    const kept = eligible.filter((_, index) => selected.has(index));
    for (let index = 0; index < eligible.length; index += 1) {
      if (!selected.has(index)) dropped.push(eligible[index]!);
    }
    return {
      kept,
      dropped,
      conflicts: [...resourceConflicts, ...SkillActivationPlanner.conflictsOf(kept)],
      duplicates,
    };
  }

  /**
   * 检测 tag 高度重叠的冲突对。
   * @param kept 实际保留的候选。
   * @returns 冲突列表（overlap ≥ 0.8）。
   */
  private static conflictsOf(kept: readonly SkillActivationCandidate[]): readonly SkillConflict[] {
    const out: SkillConflict[] = [];
    for (let i = 0; i < kept.length; i += 1) {
      for (let j = i + 1; j < kept.length; j += 1) {
        const a = kept[i]?.skill;
        const b = kept[j]?.skill;
        if (a === undefined || b === undefined) continue;
        const overlap = SkillActivationPlanner.tagOverlap(a, b);
        const resources = SkillActivationPlanner.sharedResources(a, b);
        if (overlap >= 0.8 || resources.length > 0) {
          out.push({ a: a.name, b: b.name, overlap, resources });
        }
      }
    }
    return out;
  }

  /** 两条技能共享的资源（小写化去重）。 */
  private static sharedResources(a: Skill, b: Skill): readonly string[] {
    const left = new Set((a.resources ?? []).map((item) => item.toLowerCase()));
    if (left.size === 0) return [];
    return (b.resources ?? []).filter((item) => left.has(item.toLowerCase()));
  }

  /** tag Jaccard（两边都无 tag 视为 0，不误报）。 */
  private static tagOverlap(a: Skill, b: Skill): number {
    const left = new Set((a.tags ?? []).map((tag) => tag.toLowerCase()));
    const right = new Set((b.tags ?? []).map((tag) => tag.toLowerCase()));
    if (left.size === 0 || right.size === 0) return 0;
    let intersection = 0;
    for (const tag of left) if (right.has(tag)) intersection += 1;
    return intersection / (left.size + right.size - intersection);
  }

  /** 归一化渲染文本（空白折叠，避免排版差异绕过判重）。 */
  private static normalize(text: string): string {
    return text.replace(/\s+/gu, ' ').trim();
  }
}
