/**
 * LoopGuard（Agent Loop V2 失控检测，对标 OpenHands StuckDetector + agent-loop-guard
 * 品类思想，零依赖）。
 *
 * 设计要点：
 *  - 「检测后注入纠偏，而非直接杀」（Varpulis additionalContext 模式）：首次触发只产
 *    nudge（纠偏 user 消息），同一检测器连续触发达上限才升级 abort——避免误杀长任务。
 *  - 参数规范化（LoopBuster 思想）：uuid/timestamp/hash/长随机串掩码后再比较，
 *    防止「同意图不同易变字段」漏检。
 *  - 只观察、不执行：Guard 是纯决策器，产出结构化决策，由 TurnRunner 决定干预。
 */

/** 失控检测类型。 */
export type LoopViolationKind = 'exact-repeat' | 'cycle' | 'wall-clock';

/** 一次观测输入：本步模型产出（空步不观测）。 */
export interface LoopObservation {
  /** 本步的工具调用序列（模型一次可发多个）。 */
  readonly toolCalls: readonly {
    readonly name: string;
    readonly arguments: Record<string, unknown>;
  }[];
  /** 本步时间戳（ms，供 wall-clock；缺省用内部单调时钟）。 */
  readonly ts?: number;
}

/** 检测决策：放行 / 注入纠偏 / 熔断。 */
export type LoopDecision =
  | { readonly kind: 'allow' }
  | { readonly kind: 'nudge'; readonly violation: LoopViolationKind; readonly message: string }
  | { readonly kind: 'abort'; readonly violation: LoopViolationKind; readonly message: string };

export interface LoopGuardOptions {
  /** 同调用（名+规范化参数）连续重复上限，默认 3。0 = 关闭。 */
  readonly maxExactRepeats?: number;
  /** 循环窗口长度（最近 N 个工具调用内找周期），默认 8。0 = 关闭。 */
  readonly cycleWindow?: number;
  /** 最大循环周期长度，默认 4（A→B→A→B 周期 2；A→B→C→A 周期 3）。 */
  readonly maxCyclePeriod?: number;
  /** 会话 wall-clock 上限（ms），默认 0 = 关闭。 */
  readonly maxDurationMs?: number;
  /** 同一检测连续触发多少次升级为 abort，默认 2。 */
  readonly nudgeLimit?: number;
}

const DEFAULTS = {
  maxExactRepeats: 3,
  cycleWindow: 8,
  maxCyclePeriod: 4,
  maxDurationMs: 0,
  nudgeLimit: 2,
} as const;

/** 易变字段名（值不同不代表意图不同）。 */
const VOLATILE_KEYS = new Set([
  'request_id',
  'requestid',
  'trace_id',
  'traceid',
  'span_id',
  'session_id',
  'nonce',
  'timestamp',
  'created_at',
  'updated_at',
  'seed',
]);

const NUDGE_TEXT: Record<LoopViolationKind, string> = {
  'exact-repeat':
    '【失控预警】检测到你在连续重复完全相同的工具调用。请停下来换一种方法：检查先前结果、修改参数、或改用其他工具完成任务。',
  cycle:
    '【失控预警】检测到你在两个及以上工具之间循环往复（A→B→A→B）。请打破循环：重新评估当前进度，换一条完全不同的路径，或直接总结已有信息给出结论。',
  'wall-clock':
    '【超时预警】本任务运行时间已达上限。请立即基于已获得的信息收尾：给出当前结论与剩余风险说明，不要再开启新的探索。',
};

export class LoopGuard {
  /** 同调用（名+规范化参数）连续重复上限；0 = 关闭该检测器。 */
  private readonly maxExactRepeats: number;
  /** 循环窗口长度（最近 N 个工具调用内找周期）；0 = 关闭。 */
  private readonly cycleWindow: number;
  /** 最大循环周期长度（检测 p ≤ 该值的 A→B→A→B 模式）。 */
  private readonly maxCyclePeriod: number;
  /** 会话 wall-clock 上限（ms）；0 = 关闭超时熔断。 */
  private readonly maxDurationMs: number;
  /** 同一检测连续触发多少次升级为 abort（此前只 nudge）。 */
  private readonly nudgeLimit: number;

  /** 最近工具调用序列（规范化后），供循环窗口检测。 */
  private readonly callSeq: string[] = [];
  /** 各检测器连续触发计数（nudge 升级 abort 用）。 */
  private readonly streaks = new Map<LoopViolationKind, number>();
  /** 会话起点：取首次观测的 ts（时间轴由调用方驱动，可测试注入）；无 ts 用挂钟。 */
  private startedAt: number | undefined = undefined;

  public constructor(options: LoopGuardOptions = {}) {
    this.maxExactRepeats = options.maxExactRepeats ?? DEFAULTS.maxExactRepeats;
    this.cycleWindow = options.cycleWindow ?? DEFAULTS.cycleWindow;
    this.maxCyclePeriod = options.maxCyclePeriod ?? DEFAULTS.maxCyclePeriod;
    this.maxDurationMs = options.maxDurationMs ?? DEFAULTS.maxDurationMs;
    this.nudgeLimit = options.nudgeLimit ?? DEFAULTS.nudgeLimit;
  }

  /**
   * 观测一步并给出决策。
   * @param observation 本步观测输入（工具调用序列 + 时间戳；空步不观测）。
   * @returns 结构化决策：allow 放行 / nudge 注入纠偏 / abort 熔断（由 TurnRunner 执行）。
   */
  public observe(observation: LoopObservation): LoopDecision {
    // wall-clock 检测先于模式检测：时间到了必须收尾，无论模式多「健康」。
    if (this.maxDurationMs > 0) {
      const now = observation.ts ?? Date.now();
      this.startedAt = this.startedAt ?? now;
      const elapsed = now - this.startedAt;
      if (elapsed >= this.maxDurationMs) {
        return this.decide('wall-clock');
      }
    }
    // 本步调用统一入序列（一次！exactRepeat 与 cycle 共享同一条历史，
    // 各自 push 会把序列翻倍、把单调用误判成周期 1 循环）。
    for (const call of observation.toolCalls) {
      this.callSeq.push(`${call.name}::${canonicalArgs(call.arguments)}`);
    }
    this.trimSeq();
    if (this.maxExactRepeats > 0 && this.trailingRepeatsExceed()) {
      return this.decide('exact-repeat');
    }
    if (this.cycleWindow > 0 && this.hasCycle()) {
      return this.decide('cycle');
    }
    // 本步观测健康 → 清零全部连续计数（nudge 只认「连续」违规）。
    this.streaks.clear();
    return { kind: 'allow' };
  }

  /** 检测触发计数 +1 并产出决策。wall-clock 到点直接熔断（时间已尽，nudge 无意义，
   *  收尾由 TurnRunner 的 finalize 兜底强制总结）；其余检测先 nudge，连续触达上限才 abort。
   * @param kind 触发的失控检测类型。
   * @returns nudge（首触发/未达上限）或 abort（wall-clock 或连续触达 nudgeLimit）。
   */
  private decide(kind: LoopViolationKind): LoopDecision {
    if (kind === 'wall-clock') {
      return { kind: 'abort', violation: kind, message: NUDGE_TEXT[kind] };
    }
    const streak = (this.streaks.get(kind) ?? 0) + 1;
    this.streaks.set(kind, streak);
    if (streak >= this.nudgeLimit) {
      return { kind: 'abort', violation: kind, message: NUDGE_TEXT[kind] };
    }
    return { kind: 'nudge', violation: kind, message: NUDGE_TEXT[kind] };
  }

  /**
   * 检测「同签名调用连续重复达上限」：序列尾部最后一个签名
   * 连续出现次数（含本步全部调用）≥ maxExactRepeats。
   * @returns 尾部同签名重复达上限时为 true。
   */
  private trailingRepeatsExceed(): boolean {
    if (this.callSeq.length === 0) {
      return false;
    }
    const last = this.callSeq[this.callSeq.length - 1]!;
    return this.countTrailingRepeats(last) >= this.maxExactRepeats;
  }

  /**
   * 尾部连续相同签名计数。
   * @param sig 目标签名（最后一个工具调用的规范化签名）。
   * @returns 序列尾部与 sig 连续相同的条数。
   */
  private countTrailingRepeats(sig: string): number {
    let count = 0;
    for (let i = this.callSeq.length - 1; i >= 0 && this.callSeq[i] === sig; i--) {
      count += 1;
    }
    return count;
  }

  /**
   * 检测循环窗口内的周期性模式：最近序列中，是否存在周期 p（2 ≤ p ≤ maxCyclePeriod）
   * 使尾部 2p 个调用构成「前 p == 后 p」的完整循环（至少完整走了两圈才算）。
   * 周期 1（A→A→A）是 exact-repeat 的领地，此处排除——否则单调用重复
   * 会被两个检测器双重计数，且 2 次重试（合法）就被误判循环。
   * @returns 检测到周期性循环模式时为 true。
   */
  private hasCycle(): boolean {
    const seq = this.callSeq;
    for (let p = 2; p <= this.maxCyclePeriod; p++) {
      if (seq.length < 2 * p) {
        continue;
      }
      let cyclic = true;
      for (let i = 0; i < p; i++) {
        if (seq[seq.length - 1 - i] !== seq[seq.length - 1 - i - p]) {
          cyclic = false;
          break;
        }
      }
      if (cyclic) {
        return true;
      }
    }
    return false;
  }

  /** 序列窗口裁剪：只保留最近 cycleWindow 个签名（内存有界）。
   * @returns 无返回值。
   */
  private trimSeq(): void {
    const cap = Math.max(this.cycleWindow * 2, this.maxCyclePeriod * 4, 16);
    if (this.callSeq.length > cap) {
      this.callSeq.splice(0, this.callSeq.length - cap);
    }
  }
}

/**
 * 参数规范化：易变字段掩码 + 键排序序列化，使「同意图」参数归一为同一签名。
 * 递归处理嵌套对象；数组保序（顺序通常有语义，如多个路径）。
 */
/**
 * 参数规范化：易变字段掩码 + 键排序序列化，使「同意图」参数归一为同一签名。
 * 递归处理嵌套对象；数组保序（顺序通常有语义，如多个路径）。
 * @param args 工具调用原始入参对象。
 * @returns 规范化后的 JSON 字符串签名（同意图调用恒相同）。
 */
export function canonicalArgs(args: Record<string, unknown>): string {
  return JSON.stringify(maskValue(args));
}

/**
 * 递归掩码易变字段与高熵随机串（canonicalArgs 的实现核心）。
 * @param value 任意嵌套的参数值。
 * @returns 掩码后的规范化值（易变字段与长随机串被替换为占位符）。
 */
function maskValue(value: unknown): unknown {
  if (value === null || value === undefined) {
    return null;
  }
  if (Array.isArray(value)) {
    return value.map(maskValue);
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      if (VOLATILE_KEYS.has(key.toLowerCase())) {
        out[key] = '<volatile>';
        continue;
      }
      out[key] = maskValue((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  if (typeof value === 'string') {
    // 长随机串掩码（uuid / hex hash / base64-ish）：结构同、内容不同的字符串归一。
    if (isHighEntropyToken(value)) {
      return '<opaque>';
    }
    return value;
  }
  return value;
}

/** uuid v1-v5 / 32+ 位 hex / 40+ 位混合随机串 视为不透明 token。
 * @param s 待判定的字符串值。
 * @returns 判定为高熵不透明 token 时为 true（规范化时将被掩码）。
 */
function isHighEntropyToken(s: string): boolean {
  if (s.length < 16) {
    return false;
  }
  if (/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(s)) {
    return true;
  }
  if (/^[0-9a-fA-F]{32,}$/.test(s)) {
    return true;
  }
  // 40+ 字符、无空格、字母数字混合且熵高的 token（粗判：含数字且无空白的连续串）。
  return /^[A-Za-z0-9_\-+/=]{40,}$/.test(s) && /\d/.test(s) && /[A-Za-z]/.test(s);
}
