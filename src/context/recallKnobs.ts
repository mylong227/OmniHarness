/**
 * repo-map 混合检索的旋钮解析（RecallKnobs）——「参数对象 + 三级解析」。
 *
 * 设计要点：
 *  - 把「opts > env > 默认」的三级解析**集中到一处**：调用方（RepoMapContextEngine）每次查询构造
 *    一次 RecallKnobs，随后 ranker / 语义索引构建只从只读字段取值，消除散落各处的 process.env
 *    读取与重复的 NaN 兜底（可维护性 / 可移植性：全部 env 名与本文件同址，便于文档化与跨机器部署）。
 *  - **快照语义**：构造时一次性读 env 并冻结；单次查询内各旋钮取值保证一致，不受中途改 env 影响。
 *  - 数值口径：0 是合法值（如 semWeight=0 表示完全关掉语义路），因此**不能**用 `||` 兜底
 *    ——`0 || dflt` 会把显式传入的 0 悄悄改成默认值。统一走 numeric()。
 *  - 纯解析、无 IO、无状态副作用（只读 env），可单测。
 */

import type { RepoMapContextOptions } from '../ports/context/repoMapContextOptions.js';

/** 原 RepoMapContextOptions 声明已搬入 ports/context（G25 收尾）；此处桶再导出保持公共 API 面不变。 */
export type { RepoMapContextOptions } from '../ports/context/repoMapContextOptions.js';

/** 混合检索的只读旋钮集合（构造即快照，见类注释）。 */
export class RecallKnobs {
  /** 注入碎片的文件预算。 */
  public readonly fileK: number;
  /** 注入碎片的符号预算。 */
  public readonly symK: number;
  /** RRF 融合常数 k。 */
  public readonly rrfK: number;
  /** 语义路 RRF 权重（BM25 路恒为 1）。 */
  public readonly semWeight: number;
  /** BM25 保护位（0 = 关闭）。 */
  public readonly bm25Floor: number;
  /** 是否启用符号→文件融合。 */
  public readonly mergeSymbols: boolean;
  /** 是否启用分块语义召回。 */
  public readonly chunkRecall: boolean;
  /** 是否使用全文文件文档。 */
  public readonly fullFileDoc: boolean;
  /** 文件语义文档表示模式。 */
  public readonly docMode: 'snip' | 'id';
  /** 是否启用 P5 稀疏引用图第四路。 */
  public readonly graphSignal: boolean;
  /** 第四路 RRF 权重。 */
  public readonly graphWeight: number;
  /** 载荷投送形态：'tiered'（梯度，默认）| 'degrade'（应急压缩）| 'full'（历史全大纲）。 */
  public readonly payloadShape: 'full' | 'tiered' | 'degrade';
  /** 重排头部地板个数；`undefined` = 不设地板（见 `RepoMapContextOptions.rerankFloor`）。 */
  public readonly rerankFloor: number | undefined;

  /**
   * 解析并冻结全部旋钮（三级：opts > env > 默认）。
   * @param opts 调用方显式选项（优先级最高）；缺省用 env / 默认。
   */
  public constructor(opts: RepoMapContextOptions = {}) {
    // 预算默认 20（2026-09-17 两轮决策：10→14→20）。第二轮扩档由梯度投送「买单」，见 fileK 的 JSDoc。
    this.fileK = opts.fileK ?? 20;
    this.symK = opts.symK ?? 24;
    this.rrfK = this.numeric(opts.rrfK, process.env.OMNI_RRF_K, 60, 1);
    this.semWeight = this.numeric(opts.semWeight, process.env.OMNI_SEM_WEIGHT, 1, 0);
    this.bm25Floor = this.numeric(opts.bm25Floor, process.env.OMNI_BM25_FLOOR, 0, 0);
    this.mergeSymbols = opts.mergeSymbols ?? process.env.OMNI_MERGE_SYMBOLS !== '0';
    this.chunkRecall = opts.chunkRecall ?? process.env.OMNI_CHUNK_RECALL === '1';
    this.fullFileDoc = opts.fullFileDoc ?? process.env.OMNI_FULL_FILE_DOC === '1';
    this.docMode = opts.docMode ?? (process.env.OMNI_DOC_MODE === 'id' ? 'id' : 'snip');
    this.graphSignal = opts.graphSignal ?? process.env.OMNI_GRAPH_SIGNAL === '1';
    this.graphWeight = this.numeric(opts.graphWeight, process.env.OMNI_GRAPH_WEIGHT, 1, 0);
    // 载荷投送默认 tiered（梯度）；env OMNI_PAYLOAD=full 全局回退到历史全大纲口径。
    this.payloadShape =
      opts.payloadShape ?? (process.env.OMNI_PAYLOAD === 'full' ? 'full' : 'tiered');
    // 重排地板：显式给出才生效（缺省不设地板，见字段 JSDoc）。
    this.rerankFloor = opts.rerankFloor;
  }

  /**
   * 数值旋钮解析：opts > env > 默认；非法值（空串 / NaN / 小于下界）回落默认。
   * 注意 0 是合法取值（如 semWeight=0），故不能用 `||` 兜底。
   * @param optsVal 调用方显式值（可为 undefined）。
   * @param envVal 环境变量原始字符串（可为 undefined）。
   * @param dflt 默认值。
   * @param min 允许的最小值（含）。
   * @returns 解析后的有限数值，或 dflt。
   */
  private numeric(
    optsVal: number | undefined,
    envVal: string | undefined,
    dflt: number,
    min: number,
  ): number {
    const fromEnv = envVal !== undefined && envVal.trim() !== '' ? Number(envVal) : Number.NaN;
    const raw = optsVal ?? fromEnv;
    return Number.isFinite(raw) && raw >= min ? raw : dflt;
  }
}
