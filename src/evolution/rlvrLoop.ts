/**
 * RLVR 主循环（U4 升格：StarPO 风格 sample-filter-replay）。
 *
 * 取代原「生成→评估→晋升」单次门禁，改为对同 prompt 多采样候选代码变异，
 * 用**可验证奖励**打分，过滤掉非绿（reward < 阈值）样本，只把「绿」样本推入回放缓冲
 * （replay buffer，供后续策略更新/回放）。这是 RLVR 的核心：奖励信号来自客观验证，
 * 而非 LLM 主观评判或结构启发式。
 *
 * 设计保持与现有进化门禁正交：本循环只负责「采样→验证→筛选→回放」，
 * 晋升/注册动作由调用方通过回放缓冲消费。可验证奖励由 `verifiableReward.ts` 提供。
 *
 * 无第三方依赖。
 */

/** 一个待验证的代码候选（由采样器产出）。 */
export interface CodeCandidate {
  /** 候选唯一 id。 */
  readonly id: string;
  /** 候选代码（待编译/测试验证）。 */
  readonly code: string;
  /** 任意诊断元信息。 */
  readonly meta?: Readonly<Record<string, unknown>>;
}

/**
 * 采样上下文（S5 分桶口径的工况来源）：把「这个 prompt 属于哪个工况」从候选透传到采样产物。
 *
 * 为什么必须显式透传：分桶覆盖率按候选来源算子分桶，而奖励面的对象是采样产物
 * （`CodeCandidate`）——不把来源带进来，分桶键只能靠猜 prompt 文本（口径漂移）。
 */
export interface RlvrSampleContext {
  /** 候选来源算子（如 `twist:a+b`）；分桶键取其前缀。 */
  readonly source?: string | undefined;
  /**
   * **历史失败原因**（E3+ 回填）：会被拼进采样 prompt 的失败原因段，供模型"别重犯"。
   *
   * 数据来源是既有 replay buffer / 失败模式挖掘器（`FailurePatternMiner` 的提案摘要），
   * 不需要新通道；为空或缺省 ⇒ prompt **原文透传**（不出现空标题段）。
   */
  readonly failureReasons?: readonly string[] | undefined;
}

/** 采样器：对给定 prompt 产出第 index 个候选（返回 undefined = 采样池耗尽）。 */
export interface RlvrSampler {
  /**
   * 产出第 index 个候选；返回 undefined = 采样池耗尽（停止本轮）。
   * 允许返回 Promise（模型后端异步生成代码候选），`RlvrLoop.run` 会 await。
   * @param prompt 任务 prompt
   * @param index 候选序号
   * @param context 采样上下文（工况来源；实现应写进产物的 `meta`）
   */
  sample(
    prompt: string,
    index: number,
    context?: RlvrSampleContext,
  ): CodeCandidate | undefined | Promise<CodeCandidate | undefined>;
}

/** 回放缓冲：收集「绿」样本供后续策略更新。 */
export interface ReplayBuffer {
  push(candidate: CodeCandidate, reward: number): void;
  readonly size: number;
  readonly entries: readonly { readonly candidate: CodeCandidate; readonly reward: number }[];
}

/** RLVR 循环选项。 */
export interface RlvrLoopOptions {
  /** 采样器。 */
  readonly sampler: RlvrSampler;
  /** 可验证奖励（候选 → 0..1）。 */
  readonly reward: (candidate: CodeCandidate) => Promise<number>;
  /** 回放缓冲。 */
  readonly buffer: ReplayBuffer;
  /** 每 prompt 采样数（默认 8）。 */
  readonly samplesPerPrompt?: number | undefined;
  /** 最低保留阈值（默认 0：仅保留 reward>0 的绿样本；>0 时取 r≥阈值）。 */
  readonly minReward?: number | undefined;
}

/** 单轮 RLVR 结果。 */
export interface RlvrRoundResult {
  /** 本轮回放缓冲新增的绿样本数。 */
  readonly kept: number;
  /** 本轮最佳候选（按奖励），无绿样本则为 undefined。 */
  readonly best: { readonly candidate: CodeCandidate; readonly reward: number } | undefined;
  /** 本轮回放缓冲累计大小。 */
  readonly bufferSize: number;
}

/**
 * RLVR 主循环：StarPO 风格 sample-filter-replay。
 *
 * 对给定 prompt 采样 N 个候选 → 逐一用可验证奖励打分 → 过滤 reward≥minReward 的绿样本
 * 推入回放缓冲 → 返回最佳。fail-closed：单个候选验证异常不影响其他候选。
 *
 * **E3+ 提案回填**：`context.failureReasons` 非空时，采样 prompt 会被拼上
 * {@link RlvrLoop.FAILURE_HINT_HEADER} 段（有界：最近 5 条、每条 ≤200 字符）——
 * 让模型在生成候选时看得到"上次为什么没过"。为空 ⇒ **原文透传**，不出现空标题段。
 */
export class RlvrLoop {
  /** 回填段标题（判据按**字面量**断言它；改标题即改口径）。 */
  public static readonly FAILURE_HINT_HEADER = '【历史失败原因（回填，避免重犯）】';
  /** 回填原因条数上限（只回填最近的 N 条，防 prompt 膨胀）。 */
  public static readonly MAX_FAILURE_HINTS = 5;
  /** 单条原因的字数上限（超出按字符截断并加省略号）。 */
  public static readonly MAX_HINT_CHARS = 200;

  private readonly sampler: RlvrSampler;
  private readonly reward: (candidate: CodeCandidate) => Promise<number>;
  private readonly buffer: ReplayBuffer;
  private readonly samplesPerPrompt: number;
  private readonly minReward: number;

  public constructor(opts: RlvrLoopOptions) {
    this.sampler = opts.sampler;
    this.reward = opts.reward;
    this.buffer = opts.buffer;
    this.samplesPerPrompt = Math.max(1, opts.samplesPerPrompt ?? 8);
    this.minReward = opts.minReward ?? 0;
  }

  /**
   * 跑一轮 sample-filter-replay：对同 prompt 采样 samplesPerPrompt 个候选，逐一以
   * 可验证奖励打分，把达标的绿样本推入回放缓冲（minReward>0 取 r≥阈值，否则仅保留
   * r>0）。采样器返回 undefined 即提前结束；单候选打分异常按 0 分处理（不中断本轮）。
   * @param prompt 任务 prompt（透传给采样器）
   * @param context 采样上下文（工况来源，S5 分桶口径用；缺省则不携带来源）
   * @returns 本轮结果：新增绿样本数 kept、最佳绿样本 best（无绿样本为 undefined）与回放缓冲累计大小
   */
  public async run(prompt: string, context?: RlvrSampleContext): Promise<RlvrRoundResult> {
    const effectivePrompt = RlvrLoop.composePrompt(prompt, context?.failureReasons);
    let kept = 0;
    let best: { candidate: CodeCandidate; reward: number } | undefined;
    for (let i = 0; i < this.samplesPerPrompt; i++) {
      const candidate = await this.sampler.sample(effectivePrompt, i, context);
      if (candidate === undefined) break;
      let r = 0;
      try {
        r = await this.reward(candidate);
      } catch {
        r = 0;
      }
      // 保留「绿」样本：minReward>0 时取 r≥阈值；minReward 默认 0 时保留任何奖励为正的样本
      // （reward=0 视为未通过验证，与「绿」语义一致，不进回放缓冲）。
      const keep = this.minReward > 0 ? r >= this.minReward : r > 0;
      if (keep) {
        this.buffer.push(candidate, r);
        kept++;
        if (best === undefined || r > best.reward) best = { candidate, reward: r };
      }
    }
    return { kept, best, bufferSize: this.buffer.size };
  }

  /**
   * 组装采样 prompt（E3+ 提案回填）。
   *
   * 三条口径（都有判据）：
   * 1. **空即原文**：无原因（或缺省 / 全空白）时返回**原样** prompt —— 绝不出现只有标题的空段
   *    （空段会误导模型，也会让"回填占比"这类统计失真）；
   * 2. **有界**：只取最近 {@link RlvrLoop.MAX_FAILURE_HINTS} 条，每条截断到
   *    {@link RlvrLoop.MAX_HINT_CHARS} 字符（超长失败堆栈不得把 prompt 撑爆）；
   * 3. **确定性**：同一输入恒同输出（无时间戳、无随机）。
   * @param prompt 原任务 prompt
   * @param failureReasons 历史失败原因（可缺省）
   * @returns 采样用 prompt
   */
  public static composePrompt(prompt: string, failureReasons?: readonly string[]): string {
    const hints = (failureReasons ?? [])
      .map((reason) => reason.trim())
      .filter((reason) => reason !== '')
      .slice(-RlvrLoop.MAX_FAILURE_HINTS);
    if (hints.length === 0) return prompt;
    const lines = hints.map(
      (reason) =>
        `- ${
          reason.length > RlvrLoop.MAX_HINT_CHARS
            ? `${reason.slice(0, RlvrLoop.MAX_HINT_CHARS)}…`
            : reason
        }`,
    );
    return `${prompt}\n\n${RlvrLoop.FAILURE_HINT_HEADER}\n${lines.join('\n')}`;
  }
}

export { InMemoryReplayBuffer } from './inMemoryReplayBuffer.js';
