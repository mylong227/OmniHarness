/**
 * 工具暴露规划器（ToolExposurePlanner）——「先判相关性，再决定这一步给模型看哪些工具」。
 *
 * ## 为什么要有这个模块（借鉴来源见 `docs/TASK_BOARD.md` §17）
 *
 * Laya 的高基数实测给出了一个可迁移的结论：**选项数固定、token 预算固定时，每个选项分到的
 * token 就是准确率天花板**。它那边是 77 个选项共享 `head_max_len` 预算 ⇒ 每标签只剩 3–4 token
 * ⇒ 准确率从 0.870 塌到 0.425；处方是 **coarse-to-fine 分层**（先粗分类相关组，再在组内细选）。
 *
 * 工具集是**同一形态的高基数问题**：`ConfigFactory.build` 默认装配 **33 个**工具，全部直载
 * （实测 `listDirect().length === 33`），即每一步都把 33 份完整 JSON schema 送进上下文，而一个
 * 具体任务通常只用到其中少数几类。本模块把 Laya 的处方落到这个接缝上：**按类别先粗判相关性**，
 * 把明显不相关的类别整体降为「延迟加载」。
 *
 * ## 与权限门禁方向相反，此处必须说清（否则会被误读为「收紧=安全」）
 *
 * 延迟加载**不是安全性质**，而是**成本 / 延迟权衡**。所以安全方向与沙箱/审批**正好相反**：
 * 那边宁可误拒不可误放，这边宁可**多给**不可少给（少给=能力损伤）。据此设三道硬护栏：
 *
 *  1. **未登记进任何类别的工具恒可见**——新增工具「忘了登记」只会更保守，不会更激进；
 *  2. **`alwaysVisible` 的工具恒可见**——默认含找回通道 `tool_search`、澄清通道 `ask_user`、
 *     外溢回读通道 `spill_read`；三者一旦被隐藏，模型可能连「怎么找回」都不知道；
 *  3. **无任何类别命中 ⇒ 全部可见**（fail-safe），理由如实写进 `reason`，便于观测与追责。
 *
 * 此外，被隐藏的工具**仍可经 `tool_search` 找回**：`ToolIndex` 建自 `registry.list()`（全部工具，
 * 非 `listDirect()`），且命中会登记回 `ToolDiscovery` 使后续回合可见（`toolSearchTool.ts:64-65`）。
 * 即「隐藏」是**可恢复**的，不是能力删除。这一条是本次接线安全性的前提。
 *
 * ## 纯度
 *
 * 纯函数、确定性（同输入恒同输出）、无 IO、无第三方；唯一的模块依赖是 `ports/tool/toolNames.ts`
 * 的**工具名常量表**（纯常量，2026-09-22 第三轮起工具名单一来源）。不引入任何模型，也不联网。
 * 相关度判据是**词法启发式**（英文按词边界、中文按子串），是**粗略代理**而非语义理解；
 * 其价值由 `evals/tool-exposure-ab.mjs` 的 token 对照数字度量，**不宣称能力提升**。
 */
import { TOOL_NAMES } from '../ports/tool/toolNames.js';

/** 工具类别：一组语义相近的工具 + 触发它的中英文关键词。 */
export interface ToolCategory {
  /** 类别 id（用于 `reason` 与可观测量，须稳定）。 */
  readonly id: string;
  /** 中文一句话说明该类别的用途（进 `reason`，供人读）。 */
  readonly hint: string;
  /** 触发关键词（中英混排；大小写不敏感）。 */
  readonly keywords: readonly string[];
  /** 归属该类别的工具名（未注册的名字会被忽略，不报错）。 */
  readonly tools: readonly string[];
}

/** 规划输入。 */
export interface ToolExposureInput {
  /** 本轮任务文本（用于判相关性）。空串 ⇒ 视为无信号 ⇒ 全部可见。 */
  readonly taskText: string;
  /** 全部已注册工具名。 */
  readonly tools: readonly string[];
  /**
   * 工具名 → **可检索文本**（描述 + 关键 schema 字段，T2/2026-10-03）。
   *
   * 有它时本规划器会跑一次 **BM25 检索**（"先检索再给模型"的规范处方），把检索命中的工具
   * **并入可见集**——这是**类别关键词命中**覆盖不到的那部分必需工具（例如任务问"审批"，
   * 而某工具描述里写着"审批"却没被登记进 `approval` 类别的 `tools` 列表）。
   * 缺省（undefined）⇒ 与旧行为逐位一致（只按类别 + 恒可见 + 未登记），向后兼容。
   */
  readonly toolTexts?: ReadonlyMap<string, string> | undefined;
  /**
   * BM25 检索保留名额（缺省 **8**；`0` = 关闭检索路）。
   *
   * 语义是"**并集**"而非"替换"：检索只增不减 ⇒ 不会因为检索漏召回而丢掉类别该给的工具。
   */
  readonly retrievalTopK?: number | undefined;
  /** 类别表；缺省用 {@link ToolExposurePlanner.DEFAULT_CATEGORIES}。 */
  readonly categories?: readonly ToolCategory[] | undefined;
  /** 恒可见工具名（找回 / 澄清 / 回读通道）；缺省用 {@link ToolExposurePlanner.DEFAULT_ALWAYS_VISIBLE}。 */
  readonly alwaysVisible?: readonly string[] | undefined;
}

/** 规划结果。 */
export interface ToolExposurePlan {
  /** 这一步直载给模型的工具名（按输入顺序）。 */
  readonly visible: readonly string[];
  /** 被降为延迟加载的工具名（可经 `tool_search` 找回）。 */
  readonly deferred: readonly string[];
  /** 命中的类别 id（空数组 ⇒ fail-safe 全放行）。 */
  readonly matchedCategories: readonly string[];
  /** 人类可读的判定理由（可观测 / 审计用）。 */
  readonly reason: string;
}

/** 工具暴露模式：`off` 不干预（默认）；`plan` 按类别相关性规划。 */
export type ToolExposureMode = 'off' | 'plan';

/**
 * 预编译后的类别（避免在**热路径**上重复构造正则）。
 *
 * `ascii` 是同类 ASCII 关键词合并成的单条交替正则（含词边界）；`substrings` 是含非 ASCII 的
 * 关键词（CJK 等），按子串匹配。
 */
interface CompiledCategory {
  /** 对应的原始类别（命中后直接回传，保持对外可见的类别对象不变）。 */
  readonly source: ToolCategory;
  /** ASCII 关键词的合并交替正则；无 ASCII 关键词时为 null。 */
  readonly ascii: RegExp | null;
  /** 含非 ASCII 的关键词（按子串匹配）。 */
  readonly substrings: readonly string[];
}

/**
 * 工具暴露规划器（纯函数集合）。
 *
 * 全部方法为 `static` 且无状态：同输入恒同输出，可在任意并发场景下安全调用。
 */
export class ToolExposurePlanner {
  /**
   * 恒可见工具：三条件「出事时要有」的通道 + 五个**规划产物**通道。
   *  - `tool_search`：找回被隐藏工具的唯一入口（隐藏即可恢复的前提）；
   *  - `ask_user`：澄清通道，被隐藏时模型会转向猜测而非提问；
   *  - `spill_read`：大输出外溢后的回读入口；
   *  - `todo_*` / `plan_*`：**任务拆解的唯一落地面**。它们已登记在 `planning` 类别，因此不属于
   *    「未登记 ⇒ 恒可见」的保护范围——任务文本里没出现「计划/待办/steps」字样时会被整体降级，
   *    于是「按需暴露」恰好把**规划工具本身**藏了起来：模型想拆解却找不到写待办的入口
   *    （`OMNI_TOOL_EXPOSURE=plan` 下的真实退化）。规划是元能力，按定义在任何任务里都可能需要，
   *    故并入恒可见。
   */
  public static readonly DEFAULT_ALWAYS_VISIBLE: readonly string[] = [
    TOOL_NAMES.toolSearch,
    TOOL_NAMES.askUser,
    TOOL_NAMES.spillRead,
    TOOL_NAMES.todoWrite,
    TOOL_NAMES.todoRead,
    TOOL_NAMES.planWrite,
    TOOL_NAMES.planRead,
    TOOL_NAMES.planPresent,
  ];

  /**
   * 类别表 → 预编译匹配器的缓存（按**对象引用**键，`WeakMap` 使其可回收）。
   *
   * 存在意义：`plan()` 每步调用一次，而默认类别表约 81 个关键词；若每次现编译，
   * 就是**每步 ~81 次 `new RegExp`** 的固定浪费。
   */
  private static readonly compiled = new WeakMap<
    readonly ToolCategory[],
    readonly CompiledCategory[]
  >();

  /**
   * 默认类别表——**照实**登记 `ConfigFactory.build` 默认装配的 33 个工具（实测清单，
   * 见 `evals/tool-exposure-ab.mjs` 的 `inventory` 段）。关键词中英混排，因为本仓库的任务
   * 文本常为中文。新增工具若不属于任何类别会**恒可见**，不会因遗漏而被误伤。
   */
  public static readonly DEFAULT_CATEGORIES: readonly ToolCategory[] = [
    {
      id: 'files',
      hint: '工作区文件读写',
      keywords: [
        'file',
        'read',
        'write',
        'edit',
        'patch',
        'directory',
        '文件',
        '读',
        '写',
        '编辑',
        '修改',
        // 单字「改」覆盖口语措辞（「把它改掉」「改动一下」）——2026-10-02 由
        // `evals/tool-selection-ab.mjs` 实测暴露：这类说法不含「修改」二字，会漏给 edit 工具。
        // 按本模块「宁可多给不可少给」的护栏，单字偏宽是可接受的代价（成本上升，无能力损伤）。
        '改',
        '补丁',
        '目录',
      ],
      tools: [
        TOOL_NAMES.readFile,
        TOOL_NAMES.writeFile,
        TOOL_NAMES.edit,
        TOOL_NAMES.applyPatch,
        TOOL_NAMES.listDir,
      ],
    },
    {
      id: 'search',
      hint: '工作区内容/路径检索',
      keywords: [
        'search',
        'grep',
        'find',
        'glob',
        'match',
        'regex',
        '搜索',
        '查找',
        '检索',
        '匹配',
        '正则',
      ],
      tools: [TOOL_NAMES.grep, TOOL_NAMES.glob],
    },
    {
      id: 'exec',
      hint: '命令与代码执行',
      keywords: [
        'run',
        'test',
        'build',
        'command',
        'shell',
        'bash',
        'install',
        'compile',
        '运行',
        '执行',
        '测试',
        '构建',
        '编译',
        '命令',
        '脚本',
        '安装',
      ],
      tools: [
        TOOL_NAMES.shell,
        TOOL_NAMES.shellInteractive,
        TOOL_NAMES.shellJob,
        TOOL_NAMES.runCode,
      ],
    },
    {
      id: 'web',
      hint: '在线抓取',
      keywords: [
        'http',
        'https',
        'url',
        'web',
        'fetch',
        'online',
        '网页',
        '抓取',
        '网址',
        '链接',
        '在线',
      ],
      tools: [TOOL_NAMES.webFetch],
    },
    {
      id: 'visual',
      hint: '图像、动图与视频的逐帧判读',
      keywords: [
        'image',
        'screenshot',
        'render',
        'browser',
        'chrome',
        'png',
        'gif',
        'video',
        'mp4',
        'frame',
        'motion',
        '图片',
        '截图',
        '渲染',
        '浏览器',
        '页面',
        '动图',
        '动画',
        '视频',
        '逐帧',
        '转场',
      ],
      tools: [TOOL_NAMES.browserScreenshot, TOOL_NAMES.viewImage, TOOL_NAMES.viewMedia],
    },
    {
      id: 'delegate',
      hint: '子代理 / 工作流派生',
      keywords: [
        'subagent',
        'delegate',
        'parallel',
        'workflow',
        'worker',
        '子代理',
        '委派',
        '并行',
        '工作流',
        '派生',
      ],
      tools: [TOOL_NAMES.subagent, TOOL_NAMES.runGoal, TOOL_NAMES.runWorkflow, TOOL_NAMES.delegate],
    },
    {
      id: 'planning',
      hint: '计划与待办',
      keywords: ['plan', 'todo', 'steps', '计划', '待办', '清单', '步骤', '排期'],
      tools: [
        TOOL_NAMES.todoWrite,
        TOOL_NAMES.todoRead,
        TOOL_NAMES.planWrite,
        TOOL_NAMES.planPresent,
        TOOL_NAMES.planRead,
      ],
    },
    {
      id: 'memory',
      hint: '跨会话记忆',
      keywords: [
        'memory',
        'remember',
        'recall',
        'history',
        '记忆',
        '记住',
        '回忆',
        '跨会话',
        '历史',
      ],
      tools: [TOOL_NAMES.memorySearch, TOOL_NAMES.remember, TOOL_NAMES.recall],
    },
    {
      id: 'meta',
      hint: '草图 / 策略 / 检查点等辅助',
      keywords: [
        'sketch',
        'policy',
        'checkpoint',
        'rollback',
        'spill',
        '草图',
        '策略',
        '检查点',
        '回滚',
        '外溢',
        '快照',
      ],
      tools: [
        TOOL_NAMES.sketchWrite,
        TOOL_NAMES.policyEval,
        TOOL_NAMES.checkpoint,
        TOOL_NAMES.rollback,
      ],
    },
  ];

  /**
   * 解析工具暴露模式（`OMNI_TOOL_EXPOSURE`，**默认 `plan`**）。
   *
   * ## 默认已于 2026-10-02 由 `off` 翻为 `plan`
   *
   * 翻默认的判据（本仓 D6「两关」是为排序/检索路写的，对**确定性的集合成员属性**无操作形态——
   * 无采样、无 CI、无留出折——故此处落成可执行的两条，两者同时绿才翻）：
   *
   *  1. **端到端零能力损伤**（`evals/tool-exposure-e2e.mjs --gate`）：走生产装配
   *     `ConfigFactory → Runtime → Agent.runTask`，检查**模型实际收到的 `request.tools`**。
   *     六条硬断言全过——① 接线生效 ② 直载集真裁小（33→13）③ ⊆ 计划可见集 ④ 后续步不反悔
   *     ⑤ 延迟的 `web_fetch` 经 `tool_search` 后**真的进入下一步工具表**（可找回）
   *     ⑥ **逐场景零能力损伤**（6 个跨类别场景，每一步的 `request.tools` 都覆盖该场景必需工具）。
   *  2. **注册表来源的必需工具召回 100%**（`evals/tool-selection-ab.mjs`，**已进 `eval:ci`**，
   *     故这是**常态化门禁**而非一次性评测）：工具全集取自生产注册表（不再取自 planner 自己的
   *     类别表——那曾是自证循环），37 条标注探针 × 8 类别，**37/37 完全命中**，平均可见工具
   *     33 → 14.4。
   *
   * **回退通道（逃生口，不是「默认关」）**：`OMNI_TOOL_EXPOSURE=off` 显式关闭，逐字回到
   * 「全量直载」的历史行为（该路径由单测钉住零行为变更）。
   *
   * @param env 环境变量表（缺省 `process.env`；注入以便单测）。
   * @returns `'off'` 仅当显式取值 `off`（大小写/空白不敏感）；其余一律 `'plan'`。
   */
  public static modeFromEnv(
    env: Record<string, string | undefined> = process.env,
  ): ToolExposureMode {
    return env['OMNI_TOOL_EXPOSURE']?.trim().toLowerCase() === 'off' ? 'off' : 'plan';
  }

  /**
   * 规划这一步的工具暴露。
   *
   * 判定顺序（任一护栏先行命中即短路，保证「宁多给不少给」）：
   *  ① 类别表为空 / 工具表为空 ⇒ 无信息可判 ⇒ 全部可见；
   *  ② 无任何类别命中 ⇒ **fail-safe 全部可见**；
   *  ③ 否则：命中类别的工具 ∪ 未登记工具 ∪ `alwaysVisible` 为可见，其余为延迟加载。
   *
   * @param input 规划输入（任务文本、全部工具名、可选类别表与恒可见表）。
   * @returns 规划结果（可见集、延迟集、命中类别、可读理由）。
   */
  public static plan(input: ToolExposureInput): ToolExposurePlan {
    const tools = input.tools;
    const categories = input.categories ?? ToolExposurePlanner.DEFAULT_CATEGORIES;
    const always = new Set(input.alwaysVisible ?? ToolExposurePlanner.DEFAULT_ALWAYS_VISIBLE);

    // ① 无工具 ⇒ 无从判定，全部可见。
    if (tools.length === 0) {
      return {
        visible: tools,
        deferred: [],
        matchedCategories: [],
        reason: '无已注册工具 ⇒ 全部可见',
      };
    }

    const normalized = input.taskText.trim().toLowerCase();
    const matched = ToolExposurePlanner.matchCategories(normalized, categories);

    // ② fail-safe：无类别命中（含任务文本为空）⇒ 全部可见，不冒能力损伤的风险。
    //    注意顺序也**排序**（见 §确定性排序）：调用方拿到的 schema 块顺序必须与注册顺序无关。
    if (matched.length === 0) {
      return {
        visible: ToolExposurePlanner.sorted(tools),
        deferred: [],
        matchedCategories: [],
        reason: `无类别命中 ⇒ 全部 ${tools.length} 个工具可见（fail-safe，不少给）`,
      };
    }

    const matchedTools = new Set<string>();
    for (const category of matched) {
      for (const name of category.tools) matchedTools.add(name);
    }
    // 未登记进任何类别的工具 ⇒ 恒可见（新增工具忘登记只会更保守）。
    const registered = new Set<string>();
    for (const category of categories) {
      for (const name of category.tools) registered.add(name);
    }

    // ③ T2（2026-10-03）：**BM25 检索优先**（"先检索再给模型"的规范处方）。
    //    检索只**增**不减：类别命中没覆盖到、但描述里确实相关的工具，靠这一路捞回来
    //    （判据要求"必需工具召回 100%"，纯类别关键词命中做不到这一点）。
    const retrieved = ToolExposurePlanner.retrieve(
      normalized,
      tools,
      input.toolTexts,
      input.retrievalTopK ?? ToolExposurePlanner.DEFAULT_RETRIEVAL_TOP_K,
    );

    const visible: string[] = [];
    const deferred: string[] = [];
    for (const name of tools) {
      const keep =
        matchedTools.has(name) || always.has(name) || !registered.has(name) || retrieved.has(name);
      if (keep) visible.push(name);
      else deferred.push(name);
    }

    const ids = matched.map((c) => c.id).join(',');
    return {
      // **确定性排序**（T2）：输出顺序 = 名字升序，与注册顺序 / 输入数组顺序**无关**。
      // 为什么重要：schema 块进的是 prompt 前缀，注册顺序一变（插件装载顺序、条件注册）前缀就变，
      // prompt cache 全废。排序把"同输入恒同输出"从"碰巧成立"变成"构造保证"。
      visible: ToolExposurePlanner.sorted(visible),
      deferred: ToolExposurePlanner.sorted(deferred),
      matchedCategories: matched.map((c) => c.id),
      reason:
        `命中类别 [${ids}] ⇒ 保留 ${visible.length}/${tools.length} 个工具` +
        `（其中 BM25 检索补入 ${retrieved.size} 个；延迟 ${deferred.length} 个，可经 tool_search 找回）`,
    };
  }

  /** BM25 检索缺省保留名额。 */
  private static readonly DEFAULT_RETRIEVAL_TOP_K = 8;

  /**
   * 名字升序（**确定性**；不依赖 `localeCompare`，避免随 ICU/区域设置变化）。
   * @param names 名字列表。
   * @returns 升序新数组。
   */
  private static sorted(names: readonly string[]): string[] {
    return [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }

  /**
   * BM25 检索：按任务文本给工具文本打分，返回命中的**工具名集合**（T2）。
   *
   * ## 为什么自己实现而不是复用 `search/bm25Index.ts`
   *
   * 那个是**会话文档**索引：文档带 `sessionId` / `role` / `seq` / `ts`，检索要按会话过滤与去重，
   * 语义与本处无关。工具语料只有几十篇、每篇一两句 ⇒ 这里用标准 BM25（k1=1.5、b=0.75）四十行就够，
   * 且**确定性**（无随机、无 Map 迭代顺序依赖）：把会话索引的语义搬进热路径只会带来无关约束。
   *
   * ## 分词
   *
   * 小写后按非字母数字切分（含 CJK 连续段）；CJK 段额外产出**二元组**（中文无空格，二元组是
   * 零依赖下最稳的词法交集）。任务文本与工具文本用**同一套**分词，否则交集恒空。
   *
   * @param normalizedTask 已小写 trim 的任务文本。
   * @param tools 全部工具名（结果只在这些名字里）。
   * @param toolTexts 工具名 → 可检索文本（缺省 ⇒ 不检索，返回空集）。
   * @param topK 保留名额（≤0 ⇒ 不检索）。
   * @returns 命中工具名集合（空集 ⇒ 检索路未启用或无命中）。
   */
  private static retrieve(
    normalizedTask: string,
    tools: readonly string[],
    toolTexts: ReadonlyMap<string, string> | undefined,
    topK: number,
  ): ReadonlySet<string> {
    if (toolTexts === undefined || topK <= 0 || normalizedTask === '') {
      return new Set<string>();
    }
    const queryTokens = ToolExposurePlanner.retrievalTokens(normalizedTask);
    if (queryTokens.size === 0) {
      return new Set<string>();
    }
    // 语料：只为**有文本的工具**建索引（缺文本的工具不参与检索，也就不会被"检索"误伤）。
    const docs = tools
      .map((name) => ({
        name,
        tokens: ToolExposurePlanner.retrievalTokens(toolTexts.get(name) ?? ''),
      }))
      .filter((doc) => doc.tokens.size > 0);
    if (docs.length === 0) {
      return new Set<string>();
    }
    const df = new Map<string, number>();
    for (const doc of docs) {
      for (const token of doc.tokens) df.set(token, (df.get(token) ?? 0) + 1);
    }
    const avgLen = docs.reduce((sum, doc) => sum + doc.tokens.size, 0) / docs.length;
    const k1 = 1.5;
    const b = 0.75;
    const scored = docs.map((doc) => {
      let score = 0;
      for (const token of queryTokens) {
        const freq = doc.tokens.has(token) ? 1 : 0;
        if (freq === 0) continue;
        const docFreq = df.get(token) ?? 0;
        const idf = Math.log((docs.length - docFreq + 0.5) / (docFreq + 0.5) + 1);
        score += idf * ((freq * (k1 + 1)) / (freq + k1 * (1 - b + (b * doc.tokens.size) / avgLen)));
      }
      return { name: doc.name, score };
    });
    // 只保留**有正分**的，且按分数降序、同分按名字升序（确定性）。
    return new Set(
      scored
        .filter((entry) => entry.score > 0)
        .sort((a, b2) => b2.score - a.score || (a.name < b2.name ? -1 : 1))
        .slice(0, topK)
        .map((entry) => entry.name),
    );
  }

  /**
   * BM25 分词：小写 → 非字母数字切分 → CJK 连续段补二元组。
   * @param text 原始文本。
   * @returns 词元集合（去重）。
   */
  private static retrievalTokens(text: string): ReadonlySet<string> {
    const lowered = text.toLowerCase();
    const tokens = new Set<string>();
    for (const chunk of lowered.split(/[^a-z0-9\u4e00-\u9fff]+/u)) {
      if (chunk === '') continue;
      tokens.add(chunk);
      if (/^[\u4e00-\u9fff]+$/u.test(chunk) && chunk.length > 1) {
        for (let i = 0; i + 1 < chunk.length; i += 1) {
          tokens.add(chunk.slice(i, i + 2));
        }
      }
    }
    return tokens;
  }

  /**
   * 取出命中的类别（**走预编译匹配器**，见 {@link ToolExposurePlanner.compiledOf}）。
   *
   * 词法判据：关键词**全为 ASCII** 时按词边界匹配（避免 `test` 命中 `latest`）；
   * 含非 ASCII（中文等）时按子串匹配（`\b` 对 CJK 不可靠）。
   *
   * @param normalized 已小写并 trim 的任务文本。
   * @param categories 类别表。
   * @returns 命中关键词的类别（按类别表顺序）。
   */
  private static matchCategories(
    normalized: string,
    categories: readonly ToolCategory[],
  ): ToolCategory[] {
    const hits: ToolCategory[] = [];
    if (normalized === '') {
      return hits;
    }
    for (const compiled of ToolExposurePlanner.compiledOf(categories)) {
      const asciiHit = compiled.ascii !== null && compiled.ascii.test(normalized);
      const subHit = !asciiHit && compiled.substrings.some((kw) => normalized.includes(kw));
      if (asciiHit || subHit) {
        hits.push(compiled.source);
      }
    }
    return hits;
  }

  /**
   * 取得（并缓存）类别表的预编译匹配器。
   *
   * **为什么必须预编译**：`plan()` 在**每一步**都被调用一次（`effectiveTools()` 消费点），
   * 而原先的实现对「每类别 × 每关键词」都 `new RegExp(...)` 一次——默认类别表约 81 个关键词，
   * 即**每步重建 ~81 个正则**。实测优化前单次 `plan()` **47.53 µs**（见 §17.8 前后对照）。
   *
   * 两处改动，**行为逐字不变**（由 33 条语料的差分比对钉住）：
   *  ① 同类别的 ASCII 关键词合并成**单条交替正则**（`(^|[^a-z0-9])(?:kw1|kw2)(?=$|[^a-z0-9])`）
   *     ⇒ 每类别最多 1 次正则执行，而非 N 次；尾边界用**前瞻**，与原先的消费式 `($|[^a-z0-9])`
   *     对「是否存在命中」这一布尔判定等价；
   *  ② 按**类别表对象引用**缓存（`WeakMap`）⇒ 默认表只编译一次，自定义表各自编译一次且可回收。
   *
   * @param categories 类别表（用作缓存键）。
   * @returns 与 categories 等长的预编译数组（首次调用时构建）。
   */
  private static compiledOf(categories: readonly ToolCategory[]): readonly CompiledCategory[] {
    const cached = ToolExposurePlanner.compiled.get(categories);
    if (cached !== undefined) {
      return cached;
    }
    const built = categories.map((category) => {
      const ascii: string[] = [];
      const substrings: string[] = [];
      for (const keyword of category.keywords) {
        const kw = keyword.trim().toLowerCase();
        if (kw === '') {
          continue;
        }
        // 纯 ASCII 关键词走词边界；否则（含中文等）走子串——`\b` 对 CJK 无意义。
        if (/^[a-z0-9][a-z0-9 _-]*$/.test(kw)) {
          ascii.push(kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        } else {
          substrings.push(kw);
        }
      }
      return {
        source: category,
        ascii:
          ascii.length === 0
            ? null
            : new RegExp(`(^|[^a-z0-9])(?:${ascii.join('|')})(?=$|[^a-z0-9])`),
        substrings,
      };
    });
    ToolExposurePlanner.compiled.set(categories, built);
    return built;
  }
}
