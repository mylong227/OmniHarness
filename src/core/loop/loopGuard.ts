import { ArrayAt } from '../../util/arrayAt.ts';
/**
 * LoopGuard（Agent Loop V2 失控检测，对标 OpenHands StuckDetector + agent-loop-guard
 * 品类思想，无第三方依赖）。
 *
 * 设计要点：
 *  - 「检测后注入纠偏，而非直接杀」（Varpulis additionalContext 模式）：首次触发只产
 *    nudge（纠偏 user 消息），同一检测器连续触发达上限才升级 abort——避免误杀长任务。
 *  - 参数规范化（LoopBuster 思想）：uuid/timestamp/hash/长随机串掩码后再比较，
 *    防止「同意图不同易变字段」漏检。
 *  - **结果指纹**（2026-10-19）：只看调用签名会漏掉长会话最常见的一种浪费——同一份内容
 *    被反复取回（同一文件 `read_file` 34 次、同一目录 `list_dir` 15 次）。这类重复既不连续、
 *    也不构成短周期，必须按结果内容去重才能发现。
 *  - 只观察、不执行：Guard 是纯决策器，产出结构化决策，由 TurnRunner 决定干预。
 */

/** 失控检测类型。 */
export type LoopViolationKind =
  | 'exact-repeat'
  | 'cycle'
  | 'wall-clock'
  | 'soft-deadline'
  | 'redundant-result'
  | 'edit-oscillation'
  | 'edit-thrash';

/** 一步工具结果的观测（`redundant-result` 检测用；只读、不含 callId 以外的内部结构）。 */
export interface LoopResultObservation {
  /** 工具名（用于提示文案与去重键）。 */
  readonly name: string;
  /** 是否成功；失败结果不参与重复判定（失败重试是合法行为）。 */
  readonly ok: boolean;
  /** 结果正文（只比较内容指纹，不保留原文）。 */
  readonly output: string;
}

/** 一次观测输入：本步模型产出（空步不观测）。 */
export interface LoopObservation {
  /** 本步的工具调用序列（模型一次可发多个）。 */
  readonly toolCalls: readonly {
    readonly name: string;
    readonly arguments: Record<string, unknown>;
  }[];
  /**
   * 本步工具结果（可选）。给了才会跑 `redundant-result` 检测：
   * 长会话里最烧钱的一种病是「同一份内容被反复取回」——2026-10-13 真机会话
   * `sess_mv88ycm7_1` 对同一个文件 `read_file` 34 次、结果指纹完全相同；这类重复
   * 既不连续（exact-repeat 看不见）也不构成短周期（cycle 看不见），只能靠结果指纹识别。
   */
  readonly results?: readonly LoopResultObservation[];
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
  /** 会话 wall-clock 上限（ms），默认 0 = 关闭。到点直接熔断。 */
  readonly maxDurationMs?: number;
  /**
   * 软时限（ms）：到点只注入「开始收尾」nudge，**不熔断**；配合 `maxDurationMs` 形成
   * 「先劝收尾，再硬停」的两段式。默认 0 = 关闭（由 `Agent` 按 env 装配 30 分钟）。
   */
  readonly softDeadlineMs?: number;
  /** 同一检测连续触发多少次升级为 abort，默认 2。 */
  readonly nudgeLimit?: number;
  /**
   * 同一「工具 + 结果指纹」在窗口内出现多少次判为冗余取回，默认 4；0 = 关闭。
   *
   * 为什么不是 2：读同一文件两次是合法复查（例如改完后确认），3 次已偏多，4 次基本可判定
   * 模型在**重复获取同一份信息**而没有推进。首次只 nudge（不杀），连续触发才 abort。
   */
  readonly maxRedundantResults?: number;
  /** 结果指纹窗口长度（最近 N 个成功结果），默认 64。 */
  readonly resultWindow?: number;
  /** 文件维度失控检测（振荡/抖动）开关，默认开。
   *
   * 存在理由（2026-10-01 审计）：`OMNI_LOOPGUARD=0` 只关了 `maxExactRepeats` 与
   * `cycleWindow`，edit 维度检测无门控照跑 —— 文档承诺「关闭失控检测」而实际
   * `edit-oscillation` / `edit-thrash` 连续 2 次仍会熔断，批量 codemod 场景被误杀且
   * 用户找不到关闭开关。设为 false 才是真正的全量关闭。
   */
  readonly editChecks?: boolean;
}

const DEFAULTS = {
  maxExactRepeats: 3,
  cycleWindow: 8,
  maxCyclePeriod: 4,
  maxDurationMs: 0,
  softDeadlineMs: 0,
  nudgeLimit: 2,
  maxRedundantResults: 4,
  resultWindow: 64,
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
  'soft-deadline':
    '【时限提醒】本回合已运行较长时间。请开始收尾：优先完成当前这一个改动并验证，把「还可以继续做」的部分列成清单交给用户，不要再开启新的探索或整文件重写。',
  'redundant-result':
    '【失控预警】检测到你反复取回**完全相同**的工具结果（同一文件/同一命令已返回过多次）。不要再次调用同一工具：直接用已有结果推进；若确实需要新信息，请换参数、换工具，或先说明还缺什么。',
  'edit-oscillation':
    '【失控预警】检测到你在同一个文件上来回改写（改回先前的内容形态）。请停下来读一遍当前文件，明确你要达成的那一种形态，一次改到位；若两次改动互相矛盾，先说明为什么。',
  'edit-thrash':
    '【失控预警】检测到你在短时间内反复重写同一个文件。请停止试错式改写：先 read_file 看现状、想清楚目标，再一次性改完；必要时缩小改动范围。',
};

/**
 * 写类工具名 → 目标文件与「写入内容指纹」的抽取判据。
 *
 * 为什么需要它（2026-09-26 审计 A5）：循环守卫原先只认「名 + 规范化参数」的**字节等价**签名，
 * 而 `edit` / `apply_patch` 的振荡（A→B→A）只要有一个字节不同就完全不可见 —— 模型可以无限
 * 来回改同一个文件而守卫一声不响。这里改成按**文件维度**看内容指纹的重复与重现。
 */
const WRITE_TOOL_NAMES = new Set(['edit', 'write_file', 'apply_patch']);

/** 指纹窗口（最近 N 次写操作）；与 cycleWindow 同一量级。 */
const EDIT_WINDOW = 24;
/** 同文件指纹重现（中间隔了别的形态）即判振荡。 */
const EDIT_OSCILLATION_MIN_EDITS = 3;
/** 窗口内同文件写入次数上限，超过即判抖动。 */
const EDIT_THRASH_MAX_PER_FILE = 6;

export class LoopGuard {
  /** 同调用（名+规范化参数）连续重复上限；0 = 关闭该检测器。 */
  private readonly maxExactRepeats: number;
  /** 循环窗口长度（最近 N 个工具调用内找周期）；0 = 关闭。 */
  private readonly cycleWindow: number;
  /** 最大循环周期长度（检测 p ≤ 该值的 A→B→A→B 模式）。 */
  private readonly maxCyclePeriod: number;
  /** 会话 wall-clock 上限（ms）；0 = 关闭超时熔断。 */
  private readonly maxDurationMs: number;
  /** 软时限（ms）：到点只 nudge 收尾；0 = 关闭。 */
  private readonly softDeadlineMs: number;
  /** 同一检测连续触发多少次升级为 abort（此前只 nudge）。 */
  private readonly nudgeLimit: number;
  /** 同「工具 + 结果指纹」在窗口内出现多少次判冗余；0 = 关闭。 */
  private readonly maxRedundantResults: number;
  /** 结果指纹窗口长度（最近 N 个成功结果）。 */
  private readonly resultWindow: number;
  /** 文件维度失控检测开关（editChecks=false 时 observeEdits 不跑）。 */
  private readonly editChecks: boolean;

  /** 最近工具调用序列（规范化后），供循环窗口检测。 */
  private readonly callSeq: string[] = [];
  /** 最近写操作序列（文件 + 写入内容指纹），供文件维度失控检测（A5）。 */
  private readonly editLog: { readonly file: string; readonly fp: string }[] = [];
  /** 各检测器连续触发计数（nudge 升级 abort 用）。 */
  private readonly streaks = new Map<LoopViolationKind, number>();
  /** 最近成功结果的「工具 + 内容指纹」序列（`redundant-result` 检测用，窗口有界）。 */
  private readonly resultLog: string[] = [];
  /** 会话起点：取首次观测的 ts（时间轴由调用方驱动，可测试注入）；无 ts 用挂钟。 */
  private startedAt: number | undefined = undefined;

  /**
   * 从环境变量构造（`OMNI_LOOPGUARD=0` 全关；`OMNI_LOOP_MAX_MS` / `OMNI_LOOP_SOFT_MS` 控时限）。
   * @returns LoopGuard 实例。
   */
  public static fromEnv(): LoopGuard {
    if (process.env.OMNI_LOOPGUARD === '0') {
      return new LoopGuard({
        maxExactRepeats: 0,
        cycleWindow: 0,
        editChecks: false,
        maxRedundantResults: 0,
      });
    }
    const maxRaw = process.env.OMNI_LOOP_MAX_MS;
    const softRaw = process.env.OMNI_LOOP_SOFT_MS;
    const hard = maxRaw === undefined || maxRaw === '' ? 8 * 60 * 60_000 : Number(maxRaw);
    const soft = softRaw === undefined || softRaw === '' ? 30 * 60_000 : Number(softRaw);
    return new LoopGuard({
      maxDurationMs: Number.isFinite(hard) && hard > 0 ? hard : 0,
      softDeadlineMs: Number.isFinite(soft) && soft > 0 ? soft : 0,
    });
  }

  public constructor(options: LoopGuardOptions = {}) {
    this.maxExactRepeats = options.maxExactRepeats ?? DEFAULTS.maxExactRepeats;
    this.cycleWindow = options.cycleWindow ?? DEFAULTS.cycleWindow;
    this.maxCyclePeriod = options.maxCyclePeriod ?? DEFAULTS.maxCyclePeriod;
    this.maxDurationMs = options.maxDurationMs ?? DEFAULTS.maxDurationMs;
    this.softDeadlineMs = options.softDeadlineMs ?? DEFAULTS.softDeadlineMs;
    this.nudgeLimit = options.nudgeLimit ?? DEFAULTS.nudgeLimit;
    this.editChecks = options.editChecks ?? true;
    this.maxRedundantResults = options.maxRedundantResults ?? DEFAULTS.maxRedundantResults;
    this.resultWindow = options.resultWindow ?? DEFAULTS.resultWindow;
  }

  /**
   * 观测一步并给出决策。
   * @param observation 本步观测输入（工具调用序列 + 时间戳；空步不观测）。
   * @returns 结构化决策：allow 放行 / nudge 注入纠偏 / abort 熔断（由 TurnRunner 执行）。
   */
  public observe(observation: LoopObservation): LoopDecision {
    // 时间维度先于模式检测：先看硬时限（熔断），再看软时限（只劝收尾）。
    if (this.maxDurationMs > 0 || this.softDeadlineMs > 0) {
      const now = observation.ts ?? Date.now();
      this.startedAt = this.startedAt ?? now;
      const elapsed = now - this.startedAt;
      if (this.maxDurationMs > 0 && elapsed >= this.maxDurationMs) {
        return this.decide('wall-clock');
      }
      if (this.softDeadlineMs > 0 && elapsed >= this.softDeadlineMs) {
        // 软时限**不升级为 abort**：它只是提醒模型开始收尾，硬停由 maxDurationMs 负责。
        // 也不计入 streaks（否则连续两步就会把软提醒变成熔断）。
        return {
          kind: 'nudge',
          violation: 'soft-deadline',
          message: NUDGE_TEXT['soft-deadline'],
        };
      }
    }
    // 本步调用统一入序列（一次！exactRepeat 与 cycle 共享同一条历史，
    // 各自 push 会把序列翻倍、把单调用误判成周期 1 循环）。
    for (const call of observation.toolCalls) {
      this.callSeq.push(`${call.name}::${LoopGuard.canonicalArgs(call.arguments)}`);
    }
    this.trimSeq();
    if (this.maxExactRepeats > 0 && this.trailingRepeatsExceed()) {
      return this.decide('exact-repeat');
    }
    if (this.cycleWindow > 0 && this.hasCycle()) {
      return this.decide('cycle');
    }
    // 结果维度的冗余取回（长会话主病）：不连续、无短周期，但「同一份内容」被反复拿到。
    if (this.maxRedundantResults > 0 && observation.results !== undefined) {
      const redundant = this.observeResults(observation.results);
      if (redundant !== undefined) {
        return this.decide(redundant);
      }
    }
    // 文件维度的失控（A5）：签名级检测看不见「改了 A 又改回 A」这类振荡，必须另看一眼。
    // editChecks=false（`OMNI_LOOPGUARD=0`）时跳过 —— 全量关闭必须是全量，否则批量
    // codemod 会被 edit 维度误杀且用户找不到关闭开关（2026-10-01 审计）。
    if (this.editChecks) {
      const editViolation = this.observeEdits(observation.toolCalls);
      if (editViolation !== undefined) {
        return this.decide(editViolation);
      }
    }
    // 本步观测健康 → 清零全部连续计数（nudge 只认「连续」违规）。
    this.streaks.clear();
    return { kind: 'allow' };
  }

  /**
   * 观测本步**成功结果**，判定是否在反复取回同一份内容。
   *
   * 判据：`工具名 + 结果内容指纹` 在最近 {@link resultWindow} 个成功结果里出现
   * ≥ {@link maxRedundantResults} 次。为什么按内容而不是调用签名：同一文件可以被
   * `read_file`（带不同 offset/limit）或 `grep` 多次取回，签名不同但结果完全相同；
   * 而真正推进任务时结果内容必然变化（文件改了、目录变了、搜索命中不同）。
   *
   * 边界：失败结果不参与（重试是合法行为）；过短结果不参与（`ok` / `true` 这类噪声）。
   *
   * @param results 本步工具结果。
   * @returns 命中的违规类型；健康返回 undefined。
   */
  private observeResults(results: readonly LoopResultObservation[]): LoopViolationKind | undefined {
    for (const result of results) {
      if (!result.ok) {
        continue;
      }
      const output = result.output;
      if (output.length < LoopGuard.REDUNDANT_MIN_CHARS) {
        continue;
      }
      this.resultLog.push(`${result.name}::${LoopGuard.hashText(output)}`);
    }
    if (this.resultLog.length > this.resultWindow) {
      this.resultLog.splice(0, this.resultLog.length - this.resultWindow);
    }
    const counts = new Map<string, number>();
    for (const fp of this.resultLog) {
      counts.set(fp, (counts.get(fp) ?? 0) + 1);
    }
    for (const count of counts.values()) {
      if (count >= this.maxRedundantResults) {
        // 触发后清空窗口：否则这 N 条重复会一直留在窗口里，模型哪怕立刻改好，
        // 下一步仍会「命中」并直接升级 abort —— 守卫变成不可恢复的误杀。
        // 清空后若模型继续重复，需要再攒 N 次才会再次触发（升级路径仍成立）。
        this.resultLog.length = 0;
        return 'redundant-result';
      }
    }
    return undefined;
  }

  /** 结果指纹最小长度：更短的结果（`ok`、空列表）重复是常态，不参与判定。 */
  private static readonly REDUNDANT_MIN_CHARS = 64;

  /**
   * 文本指纹（FNV-1a 32 位）；只用于相等比较，不需要抗碰撞强度。
   * @param text 结果正文。
   * @returns 8 位十六进制指纹。
   */
  private static hashText(text: string): string {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
  }

  /**
   * 观测本步的**写操作**，判定是否存在「同文件振荡」或「同文件抖动」。
   *
   * 判据基于**写入内容指纹**（而非整个调用签名）：振荡 = 同一文件的某个指纹在≥1 个中间形态
   * 之后重现（A→B→A）；抖动 = 窗口内同一文件被写超过阈值次。
   * @param calls 本步工具调用序列。
   * @returns 命中的违规类型；健康返回 undefined。
   */
  private observeEdits(
    calls: readonly {
      readonly name: string;
      readonly arguments: Record<string, unknown>;
    }[],
  ): LoopViolationKind | undefined {
    for (const call of calls) {
      if (!WRITE_TOOL_NAMES.has(call.name)) {
        continue;
      }
      const target = LoopGuard.writeTargetOf(call.name, call.arguments);
      if (target === undefined) {
        continue;
      }
      this.editLog.push({ file: target, fp: LoopGuard.fingerprintOf(call.arguments) });
      if (this.editLog.length > EDIT_WINDOW) {
        this.editLog.splice(0, this.editLog.length - EDIT_WINDOW);
      }
    }
    if (this.editLog.length < EDIT_OSCILLATION_MIN_EDITS) {
      return undefined;
    }
    // 抖动优先：同文件写入过于频繁，先劝停再谈形态。
    const perFile = new Map<string, number>();
    for (const entry of this.editLog) {
      perFile.set(entry.file, (perFile.get(entry.file) ?? 0) + 1);
    }
    for (const count of perFile.values()) {
      if (count > EDIT_THRASH_MAX_PER_FILE) {
        return 'edit-thrash';
      }
    }
    // 振荡：把该文件的指纹序列压成「连续去重」后的形态，若其中出现重复 ⇒ A→B→A。
    const last = ArrayAt.at(this.editLog, this.editLog.length - 1);
    const sequence: string[] = [];
    for (const entry of this.editLog) {
      if (entry.file !== last.file) {
        continue;
      }
      const tail = sequence[sequence.length - 1];
      if (tail !== entry.fp) {
        sequence.push(entry.fp);
      }
    }
    return new Set(sequence).size < sequence.length ? 'edit-oscillation' : undefined;
  }

  /**
   * 取写操作的目标文件（相对路径原样，不做路径归一 —— 归一需要 IO，而本类刻意无 IO）。
   * @param toolName 工具名。
   * @param args 工具参数。
   * @returns 目标文件标识；无法判定时 undefined（跳过该次观测，不误报）。
   */
  private static writeTargetOf(
    toolName: string,
    args: Record<string, unknown>,
  ): string | undefined {
    const path = args['path'];
    if (typeof path === 'string' && path !== '') {
      return path;
    }
    if (toolName !== 'apply_patch') {
      return undefined;
    }
    // apply_patch 可能不给 path：从补丁头里取第一个 `+++ b/<target>`。
    const patch = args['patch'];
    if (typeof patch !== 'string') {
      return undefined;
    }
    const match = /^\+\+\+ b\/(.+)$/m.exec(patch);
    return match?.[1]?.trim();
  }

  /**
   * 取「写入内容」的指纹：对三个写工具各自的内容字段做 FNV-1a（32 位十六进制）。
   *
   * 为什么不直接复用 `canonicalArgs`：那个会**掩码高熵串**（uuid / 长 hex），而补丁与代码片段
   * 恰恰属于此类 —— 掩码后所有大改动会长得一样，振荡就永远检测不到了。
   * @param args 工具参数。
   * @returns 稳定的短指纹（内容缺失时为固定标记）。
   */
  private static fingerprintOf(args: Record<string, unknown>): string {
    const parts = [args['content'], args['new_string'], args['patch'], args['old_string']].filter(
      (value): value is string => typeof value === 'string',
    );
    const text = parts.join('\u0000');
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
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
    const last = ArrayAt.at(this.callSeq, this.callSeq.length - 1);
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

  /** 序列窗口裁剪：只保留最近窗口个签名（内存有界）。
   *
   * cap 必须并入 `maxExactRepeats`（2026-10-03 修）：旧下界 16 与该旋钮无关，把它配成 >16 时
   * `callSeq` 先被裁到 16，`trailingRepeatsExceed` 的计数永远到不了阈值——重复检测器静默失效。
   * @returns 无返回值。
   */
  private trimSeq(): void {
    const cap = Math.max(
      this.cycleWindow * 2,
      this.maxCyclePeriod * 4,
      this.maxExactRepeats + 1,
      16,
    );
    if (this.callSeq.length > cap) {
      this.callSeq.splice(0, this.callSeq.length - cap);
    }
  }
  /**
   * maskValue (internal helper hoisted into LoopGuard).
   * @param {unknown} value
   * @returns {unknown}
   */
  public static maskValue(value: unknown): unknown {
    if (value === null || value === undefined) {
      return null;
    }
    if (Array.isArray(value)) {
      return value.map(LoopGuard.maskValue);
    }
    if (typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(value as Record<string, unknown>).sort()) {
        if (VOLATILE_KEYS.has(key.toLowerCase())) {
          out[key] = '<volatile>';
          continue;
        }
        out[key] = LoopGuard.maskValue((value as Record<string, unknown>)[key]);
      }
      return out;
    }
    if (typeof value === 'string') {
      // 长随机串掩码（uuid / hex hash / base64-ish）：结构同、内容不同的字符串归一。
      if (LoopGuard.isHighEntropyToken(value)) {
        return '<opaque>';
      }
      return value;
    }
    return value;
  }
  /**
   * isHighEntropyToken (internal helper hoisted into LoopGuard).
   * @param {string} s
   * @returns {boolean}
   */
  private static isHighEntropyToken(s: string): boolean {
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

  /**
   * 参数规范化：易变字段掩码 + 键排序序列化，使「同意图」参数归一为同一签名。
   * 递归处理嵌套对象；数组保序（顺序通常有语义，如多个路径）。
   * @param args 工具调用原始入参对象。
   * @returns 规范化后的 JSON 字符串签名（同意图调用恒相同）。
   */
  public static canonicalArgs(args: Record<string, unknown>): string {
    return JSON.stringify(LoopGuard.maskValue(args));
  }
}

/**
 * 参数规范化：易变字段掩码 + 键排序序列化，使「同意图」参数归一为同一签名。
 * 递归处理嵌套对象；数组保序（顺序通常有语义，如多个路径）。
 */

/**
 * 递归掩码易变字段与高熵随机串（canonicalArgs 的实现核心）。
 * @param value 任意嵌套的参数值。
 * @returns 掩码后的规范化值（易变字段与长随机串被替换为占位符）。
 */

/** uuid v1-v5 / 32+ 位 hex / 40+ 位混合随机串 视为不透明 token。
 * @param s 待判定的字符串值。
 * @returns 判定为高熵不透明 token 时为 true（规范化时将被掩码）。
 */
