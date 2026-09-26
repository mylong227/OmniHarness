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

/** repo-map 生产接入选项（原 repoMapContext.ts 的公开接口，迁移至此以消除循环依赖）。 */
export interface RepoMapContextOptions {
  /** 是否启用；默认开。env OMNI_REPO_MAP=0 由调用方显式传 enabled:false。 */
  readonly enabled?: boolean;
  /**
   * 注入的系统碎片里最多几个文件（默认 **20**）。
   *
   * 2026-09-17 二次决策：先由 10 → 14（精排增益随候选池深度放大，命中率 51.5% → 69.7%），再由 14 → 20。
   * 第二次扩档之所以**近乎免费**，是因为 {@link RepoMapContextOptions.payloadShape} 的梯度投送把注入
   * token 从 3703 压到 **1496（−59.6%）**——省下的预算足以覆盖更深的文件：命中率再由 69.7% 升到
   * **75.8%（+6.1pp，CI [60.6, 87.9]）**，而 token 仍**低于**原来的 fileK=14 全大纲口径。
   * 报告：`evals/military-pareto.report.json`、`evals/military-verdict.report.json`。
   */
  readonly fileK?: number;
  /**
   * repo-map 载荷投送形态（「弹药分配」）。
   *
   *  - `'tiered'`（**默认**）：梯度投送——前 3 个文件给完整符号大纲，第 4..8 个给「路径 + 命中符号名」，
   *    其余仅给一行 `📄 路径`。**文件集合逐字不变**（构造性保证，33/33 查询实测），故 `hitRate@K`
   *    必然不降；实测 token 降 **60.7%（K=14）/ 69.4%（K=20）**。
   *  - `'degrade'`：应急压缩档——**只保留 Top-1 的完整大纲**，其余全为路径行（P5 软预算降档用）。
   *    实测再降 34.6%（K=14 时 1446 → 946 token）。降档该缩「大纲档位」而非「文件数」：
   *    tiered 下 fileK 5→10 的 token 只差 34，而命中率差 18.1pp。
   *  - `'full'`：历史口径（全量符号大纲），零行为变更回退。
   *
   * env `OMNI_PAYLOAD=full` 全局回退。诚实边界：本档降低的是**注入字面信息量**，
   * 下游任务完成率是否同步不变**待 P6 端到端基准验证**，本仓库不对此作承诺。
   */
  readonly payloadShape?: 'full' | 'tiered' | 'degrade';
  /** 注入的系统碎片里最多几个符号（默认 24）。 */
  readonly symK?: number;
  /**
   * RRF 融合常数 k（默认 60）。越小排名越「尖锐」——头部命中权重越高。
   * 实测 k=20/40/60 之间结果几乎无差异（语义路质量才是主因），保留旋钮以备换模型后重调。
   * env OMNI_RRF_K 覆盖。
   */
  readonly rrfK?: number;
  /**
   * 语义路在 RRF 中的权重（BM25 路恒为 1）。<1 抑制语义噪声，>1 放大语义信号；默认 **1.0（等权）**。
   * 历史教训：曾据小样本把它调到 0.5，误判「语义噪声稀释 BM25」；真病根是文件语义文档只取正文
   * 前 600 字符（≈import 样板）。把符号名加进文档后天花板由 44.6% 升到 50.7%，此时 33 条查询扫描
   * 显示 **w=1.0 → +7.7pp，w=0.5 仅 +2.3pp**——降权是在给坏表示打补丁，表示修好后等权即最优。
   * env OMNI_SEM_WEIGHT 覆盖。
   */
  readonly semWeight?: number;
  /**
   * BM25 保护位：融合后强制保留 BM25 自己的前 N 个文件（默认 0 = 关闭）。
   * 只钉 BM25 **头部**命中，救不了中段命中；要完全消除需 floor=fileK（退化为纯 BM25）。
   * 属可选风险封顶，非万能。env OMNI_BM25_FLOOR 覆盖。
   */
  readonly bm25Floor?: number;
  /**
   * 符号→文件融合：把语义命中的**符号**映射回其所属文件，并入文件排名。
   * 默认 true（实测净增益 +5pp：33 条查询 ↑10 / ↓2 / =21；符号命中经 RRF 双重加权把共指文件顶进 Top-K）。
   * 可用 opts.mergeSymbols=false 或 env OMNI_MERGE_SYMBOLS=0 关闭。
   */
  readonly mergeSymbols?: boolean;
  /**
   * 分块语义检索（表示层破天花板的核心一刀）：把每个符号的**函数体**切成独立 chunk 作为额外语义路。
   * 默认 **false（关）**；env OMNI_CHUNK_RECALL=1 或 opts.chunkRecall=true 可开。
   * 消融证明它对召回是噪声（minilm +0.2pp）/ 有害（e5-large −0.8pp），却使构建耗时约 3–4 倍，属纯延迟税。
   */
  readonly chunkRecall?: boolean;
  /**
   * 全文文件文档（实验 1：Late Chunking 表示层破天花板）。把文件语义文档换成「路径 + 全文」。
   * 需配合长上下文代码嵌入模型（如 jina 8K）才有效——minilm(256 ctx) 喂全文会被静默截断反更差。
   * 默认 **false**；env OMNI_FULL_FILE_DOC=1 或 opts.fullFileDoc=true 可开。
   */
  readonly fullFileDoc?: boolean;
  /**
   * 文件文档表示模式（实验 1b：浓缩身份 vs 原始代码噪声）。
   * - 'snip'（GetRepoMapContext 历史默认）：rel + 符号名 + 前 600 字符原始代码。
   * - 'id'：rel + 符号名 + 各符号签名（浓缩「这个文件定义什么」身份，丢弃原始代码噪声）。
   * env OMNI_DOC_MODE=id 或 opts.docMode='id' 切换。
   */
  readonly docMode?: 'snip' | 'id';
  /**
   * P5 图/结构信号第四路：以查询命中符号为 seed，沿稀疏引用图扩散 1 跳，按文件中心性排成第四路。
   * 默认 **false（关）**；env OMNI_GRAPH_SIGNAL=1 可开。保留为实验旋钮，不作默认/不作破天花板杠杆。
   * 受控消融（2026-09-05）：单跳易查询 +0.5pp 微弱正，多跳难查询 **−2.6pp 净负**（↓6/↑3/=11），
   * 且出现 40pp 重挫实例。本地词法引用图 ≠ GraphRAG 真知识图谱，多跳增益假设证伪。
   */
  readonly graphSignal?: boolean;
  /** P5 第四路在 RRF 中的权重（BM25 路恒为 1，语义路 semWeight）。默认 **1.0**；env OMNI_GRAPH_WEIGHT 覆盖。 */
  readonly graphWeight?: number;
  /**
   * E4 深化：层化图软融合（第三路，非替换 BM25）。把层化图扩散分并入 fileScore 的 max，
   * 保留文件 BM25 地板。默认 **false（关）**；仅供评测开启，不作默认、不破生产口径
   * （D6 第二关未达标前不翻默认）。经 `getRepoMapContext(root, q, { layered: true })` 传递。
   */
  readonly layered?: boolean;
  /**
   * 两阶段检索第 2 段：**零依赖词法重排**（见 `FileReranker`）。
   *
   * 默认 **false（2026-09-25 起回关，opt-in）**：51 条新查询经第二方复核修正后，全量 84 条复跑
   * （`evals/rerank-ab.mjs` 改接 fixture）基准档点增益 +2.6pp 但 CI95 [−1.59, +7.59] 跨 0 ⇒
   * 按「CI 下界 > 0 才配当默认」两关未过。core33 仍 +5.9pp（历史默认开的基础未变），
   * 深池场景建议显式开启。
   * 历史（2026-09-17 起默认开的依据）：33 条对抗锚点查询命中率 51.5%（K=10 无精排）→
   * 54.5%（K=10+精排）→ **69.7%（K=14+精排）**，bootstrap 95% CI **[54.5, 84.8]**，两关全过；
   * 扩评测集后全量口径未能复现该稳健性，故回关。
   * 开启：`opts.rerank = true` 或 env `OMNI_RERANK=1`（用 `??` 传递，false 是合法显式值）。
   * 报告：`evals/rerank-ab.report.json`、`evals/spider-pool-ab.report.json`。
   */
  readonly rerank?: boolean;
  /**
   * 重排的头部地板个数（把第一段前 N 个候选钉在原位）。**缺省 0（不设地板）**。
   *
   * 接线补齐（2026-09-26 审计 R8）：该旋钮原先只存在于 `ContextEngine.query` 的入参上，
   * **没有任何生产路径转发它**，`RepoMapContextOptions` 里也没有这个字段 ⇒ 生产链路恒为
   * floor=0，而文档却宣称有个 `round(fileK/3)` 的默认值（纯属虚构）。现补上字段并在两条
   * 重排调用点转发，使「文档说的旋钮」真的可达；默认值保持 0（`FileReranker` 实测本语料上
   * 地板近乎无操作）。
   */
  readonly rerankFloor?: number;
  /**
   * 伪相关反馈（PRF / RM3 风格查询扩展，突破纯词法召回天花板）：用首轮 Top-3 文件的
   * 高频内容词扩展查询再搜一次并并集。**默认 false（opt-in）**：
   * 实测（`evals/recall-precision.mjs`，33 条锚点查询，真实 `src/` 语料）在 fileK=5/10
   * 档提升**准确度(precision)** +0.9~4.3pp、**召回** +2.8~7.9pp，命中率(hitRate)持平；
   * 仅 fileK=14（非默认判定档）命中率略降（60.6%→54.5%）。因命中率未过两关阈值、且
   * K=14 略回退，按本仓库纪律**不翻默认**；开启：`opts.prf = true` 或 env `OMNI_RM3=1`。
   * 与 P5 预算降档（fileK=5）天然互补：降档后 token 更紧，PRF 的精度/召回增益最显著。
   */
  readonly prf?: boolean;
}

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
