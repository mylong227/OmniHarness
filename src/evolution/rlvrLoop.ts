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
 * 零依赖。
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

/** 采样器：对给定 prompt 产出第 index 个候选（返回 undefined = 采样池耗尽）。 */
export interface RlvrSampler {
  /**
   * 产出第 index 个候选；返回 undefined = 采样池耗尽（停止本轮）。
   * 允许返回 Promise（模型后端异步生成代码候选），`RlvrLoop.run` 会 await。
   */
  sample(
    prompt: string,
    index: number,
  ): CodeCandidate | undefined | Promise<CodeCandidate | undefined>;
}

/** 回放缓冲：收集「绿」样本供后续策略更新。 */
export interface ReplayBuffer {
  push(candidate: CodeCandidate, reward: number): void;
  readonly size: number;
  readonly entries: readonly { readonly candidate: CodeCandidate; readonly reward: number }[];
}

/** 内存回放缓冲（带容量上限，超出按 FIFO 丢弃最旧）。 */
export class InMemoryReplayBuffer implements ReplayBuffer {
  private readonly items: { candidate: CodeCandidate; reward: number }[] = [];
  constructor(private readonly capacity = 256) {}
  push(candidate: CodeCandidate, reward: number): void {
    this.items.push({ candidate, reward });
    while (this.items.length > this.capacity) this.items.shift();
  }
  get size(): number {
    return this.items.length;
  }
  get entries(): readonly { candidate: CodeCandidate; reward: number }[] {
    return this.items;
  }
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
  readonly samplesPerPrompt?: number;
  /** 最低保留阈值（默认 0：仅保留 reward>0 的绿样本；>0 时取 r≥阈值）。 */
  readonly minReward?: number;
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
 */
export class RlvrLoop {
  private readonly sampler: RlvrSampler;
  private readonly reward: (candidate: CodeCandidate) => Promise<number>;
  private readonly buffer: ReplayBuffer;
  private readonly samplesPerPrompt: number;
  private readonly minReward: number;

  constructor(opts: RlvrLoopOptions) {
    this.sampler = opts.sampler;
    this.reward = opts.reward;
    this.buffer = opts.buffer;
    this.samplesPerPrompt = Math.max(1, opts.samplesPerPrompt ?? 8);
    this.minReward = opts.minReward ?? 0;
  }

  async run(prompt: string): Promise<RlvrRoundResult> {
    let kept = 0;
    let best: { candidate: CodeCandidate; reward: number } | undefined;
    for (let i = 0; i < this.samplesPerPrompt; i++) {
      const candidate = await this.sampler.sample(prompt, i);
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
}
