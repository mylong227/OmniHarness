import type { SkillPort, MoireOptions } from '../ports/runtime/skill.js';
import type { MoireMeta } from './skill.js';
import type { Skill } from './skill.js';
import { MoireComposer } from './moireComposer.js';
import { SkillRetriever } from './skillRetriever.js';

/** 相关性选择的预算与阈值（默认值即出厂口径，构造可覆盖）。 */
export interface SkillSelectOptions {
  /** 最多返回几条（默认 5，与 `SkillSparsifier` 的预算同口径）。 */
  readonly maxSkills?: number;
  /**
   * 相对阈值：低于「最高分 × 本比例」的候选直接丢弃。
   *
   * 为什么需要它（**实测依据，不是拍脑袋**）：BM25 与子串包含不同——它对**任何**查询都会给出
   * 非空排序，所以在与技能域无关的提示上照样返回一堆「相对最相关」的技能。
   * `evals/skill-routing-ab.mjs` 实测（真实语料 13 条 + 11 条等长陷阱查询）：
   *
   *  - 纯 top-5：召回 53.8%，但噪声 **4.46** 条/查询、陷阱查询平均注入 **4.09** 条；
   *  - 生产档（本比例 0.5 + top-5 + `SkillSparsifier`）：召回 **92.3%**，噪声 **1.46**、陷阱 **3.45**。
   *
   * 即用少量召回换掉一大截噪声——在「技能堆叠引噪声、且堆叠已被本仓证伪增益」的场景下，
   * 这是明确划算的一侧。故生产接线取**过滤档**而非纯 top-k。
   */
  readonly minScoreRatio?: number;
}

/**
 * @beta
 * 技能注册表：注册/列举/匹配与**相关性选择**（命中才注入上下文）。
 * 同时实现 SkillPort，提供燧-1 莫尔转角组合算子。
 *
 * ## 两条选择路径，生产走相关性那条（2026-10-02 翻默认）
 *
 *  - `selectForPrompt()`——**BM25 相关性**判据（{@link SkillRetriever}）。**这是生产注入路径的判据**
 *    （`Agent.injectSkills`）。
 *  - `match()`——**字面子串**判据（文本含技能名或任一 tag）。保留为**精确通道**（测试、诊断、
 *    按名核对、以及需要「只认字面」的场合），语义与翻默认前逐字未变。
 *
 * 翻默认依据是 `evals/skill-routing-ab.mjs` 的三道判据（真实语料 = `defaults/skills/harness-core.json`，
 * 13 条面向本仓领域的技能 × 26 条自然语言改写探针 + 11 条陷阱查询）：
 *
 *  1. **接线活性 + 跨查询敏感度**：两臂均产出结果；新路跨查询集合重合度 **0.235 < 0.6**（非常量偏置）。
 *  2. **假阳性分数下限**（本次新增判据）：BM25 对无关提示也打得出分——与正样本**等长同句式**的
 *     陷阱查询，其地板最高 **12.40**；而真命中得分中位数 **21.21**、**22/26** 条 GT 高于地板
 *     ⇒ 地板**低于**真命中区间，不构成混淆。这条判据是必需的：**没有它**，「对什么提示都返回
 *     一批技能」同样能刷出高召回。
 *  3. **第二关（同预算、配对 bootstrap + repeated 2-fold×20）**：**生产档**（即
 *     {@link SkillRegistry.selectForPrompt}）召回 **26.9% → 92.3%**、
 *     **Δ +65.4pp、CI95 [46.15, 84.62]pp、留出折 0/40 为负**。
 *
 * **代价已量化并接受**：噪声 0.04 → **1.46** 条/查询（纯 top-k 不设阈值是 4.46，故接线取
 * **相对阈值过滤档**，见 {@link SkillSelectOptions.minScoreRatio}）。
 *
 * ⚠️ **一个必须知道的机制性后果**：相对阈值是「低于最高分 × ratio 即丢」，而任何有词面重叠的提示
 * 其**最高分就是它自己** ⇒ 这道阈值**恒不会剪掉第一名**，于是**任意**提示（含与技能域完全无关的）
 * 几乎总会注入**恰好 1 条**技能——`selectForPrompt` 在实践中不会返回空。
 * 实测：无关提示平均注入 1–3.45 条（见 `evals/skill-routing-ab.mjs` 的 `traps`）。
 * 这是刻意接受的一侧（「少给 = 能力损伤」，宁可多给不可少给）；若要收掉它需要引入**绝对**阈值或
 * 语料相对水位线，但那会重新引入「阈值随语料漂移」的脆弱性，故本轮不做。
 *
 * **诚实边界**：判据是**路由命中率**而非任务成功率；语料 13 条，远低于本仓「扩到 n≥80 再判」的
 * 历史口径 ⇒ 本次是按**效应量**（+65.4pp 且 40/40 折一致）下的判，CI 宽度本身即结论的一部分，
 * 点估计不得脱离 CI 引用。完整数字见该 eval 的 report 与看板登记。
 */
export class SkillRegistry implements SkillPort {
  private readonly skills = new Map<string, Skill>();
  /** 相关性检索器（无状态、确定性；`selectForPrompt` 的唯一排序来源）。 */
  private readonly retriever = new SkillRetriever();
  /** 相关性选择预算。 */
  private readonly selectMax: number;
  /** 相关性选择的相对阈值（最高分的比例）。 */
  private readonly selectMinRatio: number;

  /**
   * @param opts 相关性选择的预算与相对阈值（缺省取出厂口径）。
   */
  public constructor(opts: SkillSelectOptions = {}) {
    this.selectMax = Math.max(1, Math.floor(opts.maxSkills ?? 5));
    this.selectMinRatio = opts.minScoreRatio ?? 0.5;
  }

  /** 注册技能；重名即抛错。
   * @returns 无返回值。
   */
  public register(skill: Skill): void {
    if (this.skills.has(skill.name)) {
      throw new Error(`技能重复注册: ${skill.name}`);
    }
    this.skills.set(skill.name, skill);
  }

  /** 原地替换既有技能（CRISPR 定点编辑用）：存在则覆盖，不存在则注册。
   * @returns 无返回值。
   */
  public replace(skill: Skill): void {
    this.skills.set(skill.name, skill);
  }

  /** 全部技能。 */
  public list(): readonly Skill[] {
    return [...this.skills.values()];
  }

  /**
   * 按需匹配：文本包含技能名或任一 tag 即命中。
   *
   * **保留为显式的字面通道**（精确、零成本），但**不再是生产注入路径的判据**——
   * 生产走 {@link SkillRegistry.selectForPrompt}。判据对比与翻默认依据见类文档。
   * @param text 提示文本。
   * @returns 字面命中的技能（按注册顺序）。
   */
  public match(text: string): readonly Skill[] {
    const lower = text.toLowerCase();
    return this.list().filter((skill) => this.isHit(skill, lower));
  }

  /**
   * 按**相关性**选择这一轮要注入的技能（**生产注入路径的判据**）。
   *
   * 三步：BM25 给全部技能打分排序 → 丢掉低于「最高分 × {@link SkillSelectOptions.minScoreRatio}」的
   * 长尾 → 截到 {@link SkillSelectOptions.maxSkills} 条。
   *
   * 「过滤档」而非纯 top-k 的理由与实测数字见 {@link SkillSelectOptions.minScoreRatio}；
   * 翻默认的完整判据见类文档。
   *
   * 空查询或无技能时返回空数组（**不做兜底全返回**——全返回正是技能堆叠噪声的来源，
   * 与 `SkillRetriever` 的取舍一致）。
   * @param text 提示文本（用户任务原文）。
   * @returns 按相关性降序、已过滤并截断的技能列表。
   */
  public selectForPrompt(text: string): readonly Skill[] {
    const all = this.list();
    if (all.length === 0 || text.trim() === '') {
      return [];
    }
    const ranked = this.retriever.rank(all, text, { topK: all.length });
    if (ranked.length === 0) {
      return [];
    }
    const top = ranked[0]?.score ?? 0;
    const floor = top * this.selectMinRatio;
    const out: Skill[] = [];
    for (const hit of ranked) {
      if (hit.score < floor) {
        break;
      }
      out.push(hit.skill);
      if (out.length >= this.selectMax) {
        break;
      }
    }
    return out;
  }

  /** 是否命中。 */
  private isHit(skill: Skill, lowerText: string): boolean {
    if (lowerText.includes(skill.name.toLowerCase())) {
      return true;
    }
    return (skill.tags ?? []).some((tag) => lowerText.includes(tag.toLowerCase()));
  }

  /** 按名称取技能。 */
  public get(name: string): Skill | undefined {
    return this.skills.get(name);
  }

  /** 渲染技能指令（注入上下文的文本）。若为莫尔组合技能，附涌现元数据。 */
  public render(skill: Skill): string {
    if (skill.moire) {
      const m = skill.moire;
      return `# 技能：${skill.name}（莫尔组合 θ*=${m.twistDeg}° 涌现=${m.emergence.toFixed(3)}）\n${skill.instructions}`;
    }
    return `# 技能：${skill.name}\n${skill.instructions}`;
  }

  /**
   * 莫尔转角组合：调用燧-1 组合算子生成复合技能，并自动注册（重名抛错）。
   * 返回承载「两片都没有的涌现长波」的可用技能。
   */
  public composeByTwist(a: Skill, b: Skill, opts?: MoireOptions): Skill & { moire: MoireMeta } {
    const composed = MoireComposer.composeByTwist(a, b, opts);
    this.register(composed);
    return composed as Skill & { moire: MoireMeta };
  }
}
