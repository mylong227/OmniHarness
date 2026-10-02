/**
 * 每文件符号视图（C7 拆分 + 性能优化，2026-10-02）。
 *
 * 审计 C7 实测：`query()` 每次**全量扫符号表**构建大纲（本仓实测 1.055ms/次），
 * 而符号集合在索引后不变——按文件分组缓存后，查询侧只需按候选文件取已分组列表
 * （实测 0.005ms 量级）。等价性不变量：以「文件在符号全集中的首现序」排序拼接，
 * 输出与 `corpus.symbols.filter(s => fileSet.has(s.file))` **逐字节一致**
 * （filter 保全集序，分组 + 首现序排序重建同一序）。
 */
import type { SymbolNode } from '../repoMap.js';

/** 视图所需的语料切片（结构化子集）。 */
export interface SymbolViewCorpus {
  /** 符号全集（索引后不变）。 */
  readonly symbols: readonly SymbolNode[];
}

/** 视图缓存（键即调用方传入的语料实例；符号集在索引后不变，缓存安全）。 */
const VIEW_CACHE = new WeakMap<object, PerFileSymbolView>();

/**
 * 每文件符号视图：按文件分组的符号列表 + 文件首现序。
 */
export class PerFileSymbolView {
  /** 文件 → 该文件的符号列表（保持全集相对序）。 */
  private readonly byFile: Map<string, SymbolNode[]>;
  /** 文件 → 在符号全集中的首现行号序（用于重建 filter 的全集序输出）。 */
  private readonly firstAppearance: Map<string, number>;

  private constructor(byFile: Map<string, SymbolNode[]>, firstAppearance: Map<string, number>) {
    this.byFile = byFile;
    this.firstAppearance = firstAppearance;
  }

  /**
   * 取（或构建）语料的每文件符号视图（按语料实例缓存）。
   *
   * @param corpus 语料切片。
   * @returns 视图实例。
   */
  public static of(corpus: SymbolViewCorpus): PerFileSymbolView {
    const cached = VIEW_CACHE.get(corpus);
    if (cached !== undefined) return cached;
    const byFile = new Map<string, SymbolNode[]>();
    const firstAppearance = new Map<string, number>();
    for (let i = 0; i < corpus.symbols.length; i += 1) {
      const s = corpus.symbols[i];
      if (s === undefined) continue;
      const arr = byFile.get(s.file);
      if (arr === undefined) {
        byFile.set(s.file, [s]);
        firstAppearance.set(s.file, i);
      } else {
        arr.push(s);
      }
    }
    const view = new PerFileSymbolView(byFile, firstAppearance);
    VIEW_CACHE.set(corpus, view);
    return view;
  }

  /**
   * 取某文件的符号列表（无符号文件为空数组）。
   *
   * @param file 文件相对路径。
   * @returns 该文件的符号列表（保持全集相对序）。
   */
  public symbolsOf(file: string): readonly SymbolNode[] {
    return this.byFile.get(file) ?? [];
  }

  /**
   * 取某文件在符号全集中的首现序（无符号文件为 +Infinity，排序沉底）。
   *
   * @param file 文件相对路径。
   * @returns 首现下标。
   */
  public orderIndex(file: string): number {
    return this.firstAppearance.get(file) ?? Number.POSITIVE_INFINITY;
  }

  /**
   * 按候选文件集重建「全集序」的符号列表（与 `symbols.filter(fileSet.has)` 逐字节一致）。
   *
   * @param fileSet 候选文件集。
   * @returns 全集序的符号列表。
   */
  public inSetOrder(fileSet: ReadonlySet<string>): readonly SymbolNode[] {
    const files = [...fileSet].sort((a, b) => this.orderIndex(a) - this.orderIndex(b));
    const out: SymbolNode[] = [];
    for (const f of files) out.push(...this.symbolsOf(f));
    return out;
  }
}
