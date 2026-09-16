/**
 * repo-map 载荷投送策略（RepoMapPayload）——「高精度导弹」的**弹药分配**。
 *
 * ## 为什么需要它
 *
 * repo-map 上下文由两块组成：`# Repo Map` 各命中文件的**完整符号大纲**，与 `# Relevant Symbols`
 * 的 Top-N 符号行。前者随 fileK 线性膨胀——14 个文件的大纲实测 **3703 token**，20 个文件 **4886**。
 *
 * 但**命中哪些文件由排序决定，注入多少字由呈现决定**，两者可解耦：
 * 排名第 1..3 的文件命中概率最高，值得给完整大纲；第 4..8 概率已明显下降，给「路径 + 命中符号名」
 * 就足以让 agent 判断是否读取；第 9 名之后给一行路径即可——**agent 有 read 工具，路径本身就是线索**。
 *
 * ## 实测（`evals/military-verdict.mjs`，33 条锚点查询，真实 `src/` 语料 482 文件）
 *
 * | 口径 | 全大纲（原状） | 梯度投送 | 降幅 |
 * | ---- | -------------- | -------- | ---- |
 * | fileK=14 | 3703 token | **1455** | **−60.7%** |
 * | fileK=20 | 4886 token | **1496** | **−69.4%** |
 * | fileK=20（生产口径 symK=24） | 4829 token | **1455** | **−69.9%** |
 * | fileK=20 应急压缩档（`DEGRADE_PLAN`） | 4829 token | **911** | **−81.1%** |
 *
 * **关键性质：这是构造性收益，不是统计推断。** 两档的**排序结果（`query().files`）逐字相同**，
 * 只改呈现形式，故 `hitRate@K` **必然不变**（33/33 实测）——不存在「为省 token 而掉召回」的风险。
 *
 * 一处**信息量反而增加**的细节：全大纲档走 `outlineText`，它只列**有声明符号**的文件；而梯度档对
 * 每个命中文件都显式给一行 `📄 路径`。故若命中集里含无符号文件（如纯 `index.ts`），梯度档**反而
 * 让它可见**（33 条查询中有 2 条属此情形）。即本策略在文本层面并非单调削减信息。
 * 省下的预算可直接反向兑换为**更深的文件覆盖**（fileK 14→20 在梯度投送下属免费）。
 *
 * ## 诚实边界（必须登记）
 *
 * 本策略降低的是**注入上下文的字面信息量**，`hitRate@K`（文件集合口径）虽然不变，
 * **下游任务完成率是否同步不变，需 P6 端到端基准验证**——本模块不作承诺。
 * 折中设计：头部信息**完整保留**，尾部仅降级为路径行，属「信息分层」而非「信息丢弃」。
 *
 * ## 回退
 *
 * `plan = null` 时逐字复现历史组装（`['# Repo Map (relevant files)', outline, '# Relevant Symbols',
 * ...sigLines].join('\n')`），保证零行为变更。`DEGRADE_PLAN` 供软预算降档用：只保留 Top-1 完整大纲。
 *
 * @maturity L2 — 构造性不变量（同文件集合）由 `evals/military-verdict.mjs` 33/33 实测，
 *   且历史组装路径逐字冻结；但「下游完成率不退化」未验证，故不主张 L3
 * @maturityEvidence tests/unit/repoMapPayload.test.ts
 */

import { outlineText, type SymbolNode } from './repoMap.js';
import { tokenize, tokenizeExpanded } from '../search/bm25Index.js';
import { ContentStopWords } from './contentStopWords.js';
import type { IndexedCorpus } from './contextEngine.js';

/** 每档最多给几个「命中符号名」（防止单文件符号过多把尾部档也撑大）。 */
const NAME_TIER_MAX_SYMBOLS = 3;

/** 载荷档位计划：前 `fullTier` 个文件给完整大纲，紧随 `nameTier` 个给「路径 + 命中符号名」。 */
export interface RepoMapPayloadPlan {
  /** 完整符号大纲档的文件个数。 */
  readonly fullTier: number;
  /** 「路径 + 命中符号名」档的文件个数（排在 `fullTier` 之后）。 */
  readonly nameTier: number;
}

/** 载荷组装输入。 */
export interface RepoMapPayloadInput {
  /** 已索引语料（提供符号表与分词口径）。 */
  readonly corpus: IndexedCorpus;
  /** 已按相关度降序的命中文件 rel 列表（**已截断到预算**）。 */
  readonly files: readonly string[];
  /** 已按相关度降序的命中符号（`# Relevant Symbols` 段）。 */
  readonly symbols: readonly SymbolNode[];
  /** 查询原文（用于抽取内容词，决定第 4..8 档列哪些符号名）。 */
  readonly query: string;
}

/** 语料级符号视图（按文件分组，WeakMap 缓存）。 */
interface CorpusSymbolView {
  /** 文件 rel → 该文件声明的符号。 */
  readonly byFile: ReadonlyMap<string, readonly SymbolNode[]>;
  /** 文件 rel → 各符号**名字的分词词集**（与 `byFile` 同序，惰性填充）。 */
  readonly nameTokens: Map<string, readonly ReadonlySet<string>[]>;
}

/**
 * 梯度投送器：按名次分档装配 repo-map 上下文文本。无状态、确定性、零依赖。
 */
export class RepoMapPayload {
  /** 默认档位计划：3 个完整大纲 + 5 个「路径 + 命中符号名」。 */
  public static readonly DEFAULT_PLAN: RepoMapPayloadPlan = { fullTier: 3, nameTier: 5 };
  /**
   * 应急压缩计划（P5 软预算降档）——**只保留 Top-1 的完整大纲**，其余全降为路径行。
   *
   * 为什么降档该缩「全大纲档位」而不是「文件数」：注入 token 的大头是**前几档的完整符号大纲**
   * （每文件数百 token），尾部路径行每行仅约 7 token。实测 fileK 5→10 的 tiered token 只差 34
   * （1030 → 1064），而命中率差 **18.1pp**（36.4% → 54.5%）——即「缩文件数」几乎不省 token 却大损召回。
   * 真正有效的是把 `fullTier` 由 3 收到 1：K=14 时 1446 → **946 token（再降 34.6%）**。
   */
  public static readonly DEGRADE_PLAN: RepoMapPayloadPlan = { fullTier: 1, nameTier: 0 };

  /** 语料 → 按文件分组的符号视图；语料回收即自动释放。 */
  private static readonly views = new WeakMap<IndexedCorpus, CorpusSymbolView>();

  /**
   * 组装 repo-map 上下文文本。
   *
   * `plan === null` 时**逐字复现**历史组装（全量符号大纲，零行为变更）；否则按 `plan.fullTier` /
   * `plan.nameTier` 两档梯度投送，其余文件仅给 `📄 路径` 一行。
   * @param input 语料 + 命中文件 + 命中符号 + 查询原文
   * @param plan 档位计划；`null` = 历史全大纲口径
   * @returns 可注入 system 消息的上下文文本
   */
  public static assemble(input: RepoMapPayloadInput, plan: RepoMapPayloadPlan | null): string {
    const { corpus, files, symbols, query } = input;
    const sigLines = symbols.map((s) => `L${s.line} ${s.kind} ${s.name} @ ${s.file}`);
    if (plan === null) {
      // 历史组装路径：逐字不动（评测报告口径冻结）。
      const fileSet = new Set(files);
      const outline = outlineText(corpus.symbols.filter((s) => fileSet.has(s.file)));
      return ['# Repo Map (relevant files)', outline, '# Relevant Symbols', ...sigLines].join('\n');
    }
    const view = RepoMapPayload.viewOf(corpus);
    const terms = RepoMapPayload.contentTermsOf(corpus, query);
    const parts: string[] = ['# Repo Map (relevant files)'];
    for (let i = 0; i < files.length; i += 1) {
      const rel = files[i];
      if (rel === undefined) continue;
      const full = i < plan.fullTier;
      const named = !full && i < plan.fullTier + plan.nameTier;
      if (full) {
        const outline = outlineText(view.byFile.get(rel) ?? []);
        if (outline !== '') parts.push(outline);
        continue;
      }
      parts.push(`📄 ${rel}`);
      if (!named) continue;
      for (const s of RepoMapPayload.matchedSymbols(
        view.byFile.get(rel) ?? [],
        RepoMapPayload.nameTokensOf(corpus, view, rel),
        terms,
      )) {
        parts.push(`   L${s.line} ${s.kind} ${s.name}`);
      }
    }
    parts.push('# Relevant Symbols', ...sigLines);
    return parts.join('\n');
  }

  /**
   * 取某文件的「名字命中查询内容词」的声明符号（最多 {@link NAME_TIER_MAX_SYMBOLS} 个）。
   *
   * 名字按 camelCase 拆分 / 词形归并后与内容词求交——否则整串小写的 `alphaWidget`
   * 永远匹配不上查询词 `widget`（与索引侧同一分词口径）。
   * @param syms 该文件声明的符号（与 `tokens` 同序）
   * @param tokens 各符号名字的分词词集（与 `syms` 同序）
   * @param terms 查询内容词集合
   * @returns 命中的符号子集（保序、已截断）
   */
  private static matchedSymbols(
    syms: readonly SymbolNode[],
    tokens: readonly ReadonlySet<string>[],
    terms: ReadonlySet<string>,
  ): readonly SymbolNode[] {
    if (terms.size === 0) return [];
    const out: SymbolNode[] = [];
    for (let i = 0; i < syms.length; i += 1) {
      const s = syms[i];
      const tk = tokens[i];
      if (s === undefined || tk === undefined) continue;
      let hit = false;
      for (const t of tk) {
        if (terms.has(t)) {
          hit = true;
          break;
        }
      }
      if (hit) out.push(s);
      if (out.length >= NAME_TIER_MAX_SYMBOLS) break;
    }
    return out;
  }

  /**
   * 取（或惰性构建）某文件各符号名字的分词词集（与 `byFile` 顺序一一对应）。
   * @param corpus 已索引语料（提供 morph 口径）
   * @param view 该语料的符号视图
   * @param rel 文件相对路径
   * @returns 各符号名字的词集数组
   */
  private static nameTokensOf(
    corpus: IndexedCorpus,
    view: CorpusSymbolView,
    rel: string,
  ): readonly ReadonlySet<string>[] {
    const cached = view.nameTokens.get(rel);
    if (cached !== undefined) return cached;
    const syms = view.byFile.get(rel) ?? [];
    const out = syms.map((s) => {
      const raw = corpus.morph ? tokenizeExpanded(s.name) : tokenize(s.name);
      return new Set(raw);
    });
    view.nameTokens.set(rel, out);
    return out;
  }

  /**
   * 抽取查询的内容词（形态归并分词 → 去停用词 → 小写集合）。
   * @param corpus 已索引语料（提供 morph 口径）
   * @param query 查询原文
   * @returns 内容词集合
   */
  private static contentTermsOf(corpus: IndexedCorpus, query: string): ReadonlySet<string> {
    const tokens = corpus.morph ? tokenizeExpanded(query) : tokenize(query);
    const out = new Set<string>();
    for (const t of tokens) {
      if (ContentStopWords.isContent(t)) out.add(t);
    }
    return out;
  }

  /**
   * 取（或构建）某语料的按文件符号视图。
   * @param corpus 已索引语料
   * @returns 该语料的符号视图
   */
  private static viewOf(corpus: IndexedCorpus): CorpusSymbolView {
    const cached = RepoMapPayload.views.get(corpus);
    if (cached !== undefined) return cached;
    const byFile = new Map<string, SymbolNode[]>();
    for (const s of corpus.symbols) {
      const arr = byFile.get(s.file);
      if (arr === undefined) byFile.set(s.file, [s]);
      else arr.push(s);
    }
    const view: CorpusSymbolView = { byFile, nameTokens: new Map() };
    RepoMapPayload.views.set(corpus, view);
    return view;
  }
}
