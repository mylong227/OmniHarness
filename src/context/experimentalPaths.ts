/**
 * **实验档检索路径清单与删除边界**（G19，2026-10-03 第十七轮）。
 *
 * ## 为什么要有这份清单
 *
 * 检索栈里有多条路径被**本项目自己反复证伪**（净负面 / 零增益），却仍占着维护面：
 * 每次改索引结构都要连带改它们、每次读代码都要重新判断"这条还在用吗"。报告 G19 的要求是
 * **明确标注"实验档、默认关、可删"并评估删除边界**——本文件就是那份标注，且**由判据兜底**
 * （`tests/unit/retrievalStackStatus.test.ts` 会核对：声明已删的文件真的不在了、声明的默认值真的是关、
 * 声明的边界文件真的没有边界外的引用者）。
 *
 * ## 边界怎么定义（判据怎么核）
 *
 * 每条路径给出 `boundaryFiles` = **删除它需要一起动的文件集合**。判据会遍历 `src/**` 的 import 边，
 * 断言这些文件的引用者**全部**落在边界集合 ∪ `entryPoints` 内——即"删掉这条路径不会牵连边界外的代码"。
 * 边界一旦不成立（有人在边界外接了它），判据立刻红：那就是"删除前必须先处理"的真实信号。
 *
 * ## 口径（别把这份清单读成"这些功能有用但先关着"）
 *
 * 每一行的 `evidence` 都是**本仓实测数字**，不是外部文献转述；`status: 'deleted'` 表示代码已删。
 * 保留 `kept` 的路径仍可显式开启（评测/对照用），但生产默认关闭，并且**开启时会在运行期告警**
 * （见 {@link ExperimentalPaths.warningsFor}），避免有人以为它们是"已打磨的生产能力"。
 */
export class ExperimentalPaths {
  /** 逐条实验档路径的现状与边界。 */
  public static readonly PATHS: readonly ExperimentalPath[] = [
    {
      id: 'lsa',
      label: 'LSA 潜语义召回（符号×词项 TF-IDF 截断 SVD 第三路）',
      status: 'deleted',
      knob: '（已删除：`ContextEngine.query` 的 `lsa` 选项与 `OMNI_*` 开关一并移除）',
      defaultOn: false,
      evidence:
        '实测召回持平（潜语义在 morph 之上无增量）、符号精确率腰斩，属净负面；2026-10-03 G19 整体删除',
      deletedFiles: ['src/context/lsaEngine.ts', 'tests/unit/lsaRecall.test.ts'],
      boundaryFiles: [],
      entryPoints: [],
      deletedInRound: 'G19（2026-10-03）',
    },
    {
      id: 'graph-family',
      label: '图家族三路：代码拓扑图 PageRank 扩散 / 层化图软融合 / P5 稀疏引用图第四路（RRF）',
      status: 'kept',
      knob: '`ContextEngine.query({ graph: true })` / `{ layered: true }` / `OMNI_GRAPH_SIGNAL=1`（生产恒关；light 模式连图都不建）',
      defaultOn: false,
      evidence:
        '稠密图零增益（收敛至均匀）+ graph −3.6pp 确认负；层化图 D6 第二关未达标；P5 多跳难查询 −2.6pp 净负（有 40pp 重挫实例）',
      // 边界评估结论（2026-10-03 实测）：三条路**共用** `symbolFileFusion` / `codeGraphIndex` / `codeReferenceGraph`
      // 等 stage 文件 ⇒ 它们不是三条独立可删路径，而是**一个必须一起动或一起留的家族**。首版把它们拆成
      // 三条独立边界，判据当场报出跨边界引用（codeGraphIndex ← codeReferenceGraph、layeredGraphFusion ← symbolFileFusion）。
      boundaryFiles: [
        'src/context/codeGraphIndex.ts',
        'src/context/layeredCodeGraph.ts',
        'src/context/codeReferenceGraph.ts',
        'src/context/hybridRanker.ts',
        'src/context/queryStages/layeredGraphFusion.ts',
        'src/context/queryStages/symbolFileFusion.ts',
      ],
      entryPoints: ['src/context/contextEngine.ts', 'src/context/repoMap/repoMapContextEngine.ts'],
    },
    {
      id: 'spectral',
      label: '频域共振检索路（语料侧 `symbolSpectra` 频谱 + 种子融合里的共振打分）',
      status: 'kept',
      knob: '语料 `symbolSpectra`（light 模式跳过不建）；`SeedFusion` 内固定权重 0.4',
      defaultOn: false,
      evidence:
        '同 corpus 隔离对照实测**纯零效应**（此前某次「+2.5pp」是 full vs light 两语料混淆的假象）',
      // 边界评估结论（2026-10-03 实测）：**只**含检索侧的种子融合。
      // 首版把 `src/util/eigenspectrum.ts` 也列了进来 —— 判据当场报出它还有 **9 个非检索消费者**
      // （退火 / 共振场 / 顿悟蚀刻 / CRISPR / 涡环 / cosmicWeb / resonantField / resonantMemory / index.ts）：
      // 那是**共享数学基础设施**，删检索路**不**该动它，故明确排除在边界外（并在此登记，免得下次又误列）。
      boundaryFiles: ['src/context/queryStages/seedFusion.ts'],
      entryPoints: ['src/context/contextEngine.ts'],
    },
  ];

  /**
   * 列出**有人开启**的实验档告警（生产路径调用；空数组表示没有人在用实验档）。
   *
   * 语义：这里不是"禁止开启"，而是"**如实告知**你开的是哪条、它的实测结论是什么"——
   * 本仓最贵的教训是"叙事跑在验证前面"，实验档被静默当成生产能力正是那类事故的温床。
   * @param enabled 已开启的实验档 id 集合（调用方按生效旋钮给出）。
   * @returns 每条告警一行文本。
   */
  public static warningsFor(enabled: readonly string[]): readonly string[] {
    const out: string[] = [];
    for (const id of enabled) {
      const path = ExperimentalPaths.PATHS.find((p) => p.id === id);
      if (path === undefined) {
        out.push(`[实验档] 未知检索路径 id：${id}（清单里没有它 ⇒ 请补登记或核对拼写）`);
        continue;
      }
      const mark = path.status === 'deleted' ? '已删除' : '保留（默认关）';
      out.push(
        `[实验档·${path.id}] ${path.label} —— ${mark}；实测：${path.evidence}` +
          `${path.deletedInRound === undefined ? '' : `；删除于 ${path.deletedInRound}`}`,
      );
    }
    return out;
  }

  /**
   * 删除边界自查（**供判据调用**）：给定"文件 → 其引用者"的边表，返回越界的引用。
   *
   * 判据为什么调它而不是自己算：边界语义只能有一处实现，否则"声明"与"核对"会各写一份而漂移。
   * @param edges 文件相对路径 → 引用它的文件集合（都在 `src/**` 内）。
   * @returns 每条 `{ pathId, file, importer }` 越界记录（空数组 = 边界成立）。
   */
  public static boundaryViolations(
    edges: ReadonlyMap<string, readonly string[]>,
  ): readonly { readonly pathId: string; readonly file: string; readonly importer: string }[] {
    const violations: { pathId: string; file: string; importer: string }[] = [];
    for (const path of ExperimentalPaths.PATHS) {
      const allowed = new Set<string>([...path.boundaryFiles, ...path.entryPoints]);
      for (const file of path.boundaryFiles) {
        for (const importer of edges.get(file) ?? []) {
          if (!allowed.has(importer)) {
            violations.push({ pathId: path.id, file, importer });
          }
        }
      }
    }
    return violations;
  }
}

/** 一条实验档检索路径的登记项。 */
export interface ExperimentalPath {
  /** 稳定 id（判据按它核对）。 */
  readonly id: string;
  /** 人读标签。 */
  readonly label: string;
  /** 现状：`deleted` = 代码已删；`kept` = 保留但默认关。 */
  readonly status: 'deleted' | 'kept';
  /** 开启它的旋钮/选项（人读）。 */
  readonly knob: string;
  /** 默认是否开启（判据核对：实验档必须为 false）。 */
  readonly defaultOn: boolean;
  /** 本仓实测证据（数字，不是外部转述）。 */
  readonly evidence: string;
  /** 已删除的文件（`status: 'deleted'` 时判据会核对它们真的不存在）。 */
  readonly deletedFiles?: readonly string[];
  /** 删除边界：删这条路径需要一起动的文件。 */
  readonly boundaryFiles: readonly string[];
  /** 边界外的合法引用者（通常是装配它的上下文引擎）。 */
  readonly entryPoints: readonly string[];
  /** 删除发生的轮次（`status: 'deleted'` 时给出）。 */
  readonly deletedInRound?: string;
}
