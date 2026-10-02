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
 *  - **不改变 `SkillRegistry.match()` 的语义**：它保留为**精确通道**（测试、诊断、按名核对），
 *    逐字未变。生产注入路径改走 `SkillRegistry.selectForPrompt()`——本类做排序，**并**加一道
 *    相对阈值过滤（原因与实测数字见该方法的 `minScoreRatio` 文档：BM25 对任何查询都给得出排序，
 *    不过滤会灌噪声）。
 *  - **无状态、确定性**：同输入恒同输出；不持有技能集合，每次由调用方传入（与
 *    `SkillSparsifier` 同构）。
 *  - **只排序不裁剪**：裁剪交给调用方或 `SkillSparsifier`（单一职责）。
 *  - **零命中即返回空**：BM25 无命中 ⇒ 真的不相关，**不做兜底全返回**——全返回正是「堆叠噪声」的来源。
 *
 * @maturity L2 — 结构同构（技能文档 → 词袋 → BM25 打分，与文本检索同构）**且已端到端证明**：
 *   `evals/skill-routing-ab.mjs` 在真实语料上过三道判据（跨查询敏感度 0.235 < 0.6；
 *   假阳性分数下限 6.26 < GT 中位数 21.21；同预算配对 bootstrap 召回 53.8%→92.3%、
 *   CI95 [19.23, 57.69]pp、留出折 0/40 为负），据此接入生产注入路径。
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
   *
   * 文档侧用 `tokenizeExpandedCounted`（与查询侧 `tokenizeExpanded` **同一函数族的展开口径**，
   * 但保留词频）。这条对齐是 `src/search/bm25Index.ts` 明写的契约——「文档侧与查询侧使用同一
   * 函数，两侧同时展开后交集命中」——repo-map 路径即如此。此前本类文档侧用未展开的 `tokenize`，
   * 于是**含 camelCase 或变形的查询词在文档侧根本没有对应 token**，是静默漏召：
   * `repoMapContextEngine` 用「展开 + 计数」后实测召回提升，本类没有理由不同口径。
   * @param skill 技能。
   * @returns 文档 token 数组（保留词频）。
   */
  public documentOf(skill: Skill): readonly string[] {
    const tags = (skill.tags ?? []).join(' ');
    return Bm25Index.tokenizeExpandedCounted(`${skill.name} ${tags} ${skill.instructions ?? ''}`);
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
