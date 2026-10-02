/**
 * 技能**相关性检索器**（SkillRetriever）——用 BM25 给技能排序，替代「文本里有没有出现技能名」。
 *
 * ## 为什么需要它（当技能数量上去之后）
 *
 * `SkillRegistry.match()` 的判据是 `text.includes(技能名或 tag)`——**字面子串**。它在两种
 * 常见情况下会漏召：
 *  1. **同义改写**：用户说「把这个流程自动化」，技能叫 `workflow-automation`，字面无交集；
 *  2. **措辞分散**：技能描述的关键词分布在 `tags` + `instructions` 里，而查询只用了其中一部分。
 *
 * 反过来它也会**误召**：短技能名（如 `go`、`test`）作为子串会在无关文本里大量命中，
 * 把噪声灌进上下文——而「技能堆叠引噪声」是本仓已记录的结论（人工技能 +16.2pp，
 * AI 自生成技能无正增益、堆叠反而有害）。
 *
 * 本类用**已有的** `Bm25Index`（零第三方依赖）对「技能名 + 标签 + 指令正文」建索引，
 * 按查询给技能打分排序，同时保留 `SkillSparsifier` 的强命中豁免语义（名字级命中不被预算剪掉）。
 *
 * ## 刻意的设计取舍
 *
 *  - **不改动 `SkillRegistry.match()`**：那是生产默认路径，改它属于行为变更。本类是**可选**
 *    检索器，由调用方显式选用（opt-in），默认行为零变更。
 *  - **无状态、确定性**：同输入恒同输出；不持有技能集合，每次由调用方传入（与
 *    `SkillSparsifier` 同构）。
 *  - **只排序不裁剪**：裁剪交给 `SkillSparsifier`（单一职责）。
 *  - **零命中即返回空**：BM25 无命中 ⇒ 真的不相关，**不做兜底全返回**——全返回正是「堆叠噪声」的来源。
 *
 * @maturity L1 — 结构同构：技能文档 → 词袋 → BM25 打分，与文本检索同构；
 *   但「BM25 排序优于子串包含」这一收益**尚未在本仓端到端证明**（缺少足量真实技能），
 *   故保持 opt-in，不替代默认路径。
 * @maturityEvidence tests/unit/skillRetriever.test.ts
 */
import { Bm25Index } from '../search/bm25Index.js';
import type { Skill } from './skill.js';

/** 检索选项。 */
export interface SkillRetrieveOptions {
  /** 最多返回条数（默认 5，与 `SkillSparsifier` 的预算同口径）。 */
  readonly topK?: number;
  /** 得分下限：低于此值视为不相关，直接不返回（默认 0）。 */
  readonly minScore?: number;
}

/** 单条检索结果。 */
export interface SkillRetrieveHit {
  /** 命中的技能。 */
  readonly skill: Skill;
  /** BM25 得分（越高越相关；可能为负，取决于实现）。 */
  readonly score: number;
}

/**
 * 技能相关性检索器（BM25，零第三方依赖，无状态）。
 */
export class SkillRetriever {
  /** 默认返回条数。 */
  private static readonly DEFAULT_TOP_K = 5;

  /**
   * 把技能集合渲染成可检索的文档（技能名 + 标签 + 指令正文）。
   * @param skill 技能。
   * @returns 文档 token 数组。
   */
  public documentOf(skill: Skill): readonly string[] {
    const tags = (skill.tags ?? []).join(' ');
    return Bm25Index.tokenize(`${skill.name} ${tags} ${skill.instructions ?? ''}`);
  }

  /**
   * 按查询给技能排序。
   * @param skills 候选技能（任意顺序）。
   * @param text 查询/提示文本（空串 ⇒ 返回空，不做兜底全返回）。
   * @param opts topK 与得分下限（均可缺省）。
   * @returns 按得分降序的命中列表（已截断到 topK）。
   */
  public rank(
    skills: readonly Skill[],
    text: string,
    opts: SkillRetrieveOptions = {},
  ): readonly SkillRetrieveHit[] {
    const trimmed = text.trim();
    if (trimmed.length === 0 || skills.length === 0) {
      return [];
    }
    const topK = Math.max(1, Math.floor(opts.topK ?? SkillRetriever.DEFAULT_TOP_K));
    const minScore = opts.minScore ?? 0;

    const index = new Bm25Index();
    index.addDocuments(skills.map((s) => [...this.documentOf(s)]));
    const hits = index.search(Bm25Index.tokenizeExpanded(trimmed), skills.length);

    const out: SkillRetrieveHit[] = [];
    for (const hit of hits) {
      const skill = skills[hit.id];
      if (skill === undefined) continue;
      if (hit.score < minScore) continue;
      out.push({ skill, score: hit.score });
      if (out.length >= topK) break;
    }
    return out;
  }
}
