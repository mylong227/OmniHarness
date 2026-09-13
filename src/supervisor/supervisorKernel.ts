/**
 * 航天级监督内核实现（I-P0-3 / FDIR）。
 *
 * - Fault Detection：滑动窗口统计每工具成败，算健康分与失败率。
 * - Isolation：失败率/连续失败越线即把系统推进更严模式，危险工具被隔离。
 * - Recovery：健康恢复后 `attemptRecovery()` 逐级回升；模式每次切换都入审计哈希链。
 *
 * 默认零配置即可用；注入 AuditSink 后，每次模式转移把健康向量写入哈希链
 * （满足「健康向量入审计链」验收项）。
 *
 * @beta 属 P0 内核升级子系统，接口仍可能微调。
 */
import { log } from '../util/logger.js';
import type {
  AuditSinkLike,
  HealthEntry,
  HealthSnapshot,
  SafeMode,
  SupervisorOptions,
  SupervisorPort,
} from '../ports/supervisor.js';

const DEFAULT_WINDOW = 32;
const DEFAULT_DEGRADE = 0.25;
const DEFAULT_SAFE = 0.5;
const DEFAULT_LOCK = 5;

/** 单工具统计（滑动窗口 + 连续失败计数）。 */
interface ToolStat {
  /** 滑动窗口（true=成功，false=失败），仅保留最近 windowSize 条。 */
  window: boolean[];
  /** 当前连续失败计数（成功即清零）。 */
  consecutiveFailures: number;
  /** 最近一次错误（若有）。 */
  lastError?: string;
}

/** 模式严格度排序：nominal 最松，locked 最严。 */
const MODE_ORDER: readonly SafeMode[] = ['nominal', 'degraded', 'safe', 'locked'];

function toSet(t: SupervisorOptions['hazardousTools']): ReadonlySet<string> {
  if (t === undefined) return new Set();
  return t instanceof Set ? t : new Set(t);
}

/** 生产级监督内核（FDIR 状态机，详见文件头），实现 {@link SupervisorPort}：滑动窗口健康统计 + 分级降级 + 逐级恢复。 */
export class SupervisorKernel implements SupervisorPort {
  /** 滑动窗口长度：每工具仅保留最近 N 次成败样本（默认 32）。 */
  private readonly windowSize: number;
  /** 降级阈值：任一工具失败率达到该比例即推进到 degraded（默认 0.25）。 */
  private readonly degradeThreshold: number;
  /** 安全阈值：失败率达到该比例推进到 safe；恢复时全部工具未越此线才允许回升（默认 0.5）。 */
  private readonly safeThreshold: number;
  /** 连续失败锁定线：任一工具连续失败达该次数直接 locked（默认 5）。 */
  private readonly lockAfter: number;
  /** 危险工具名集合：safe/locked 模式下被 intercept 直接否决。 */
  private readonly hazardous: ReadonlySet<string>;
  /** 可选审计 sink：每次模式转移把前后模式与健康向量写入审计哈希链。 */
  private readonly audit?: AuditSinkLike;
  /** 会话标识：写入审计记录，便于跨事件关联到同一会话。 */
  private readonly sessionId?: string;

  /** 每工具滑动窗口统计（成败窗口、连续失败计数、最近错误）。 */
  private readonly stats = new Map<string, ToolStat>();
  /** 当前监督模式（fail-closed：评估只单向收紧，回升必须走显式 attemptRecovery）。 */
  private currentMode: SafeMode = 'nominal';
  /** 模式转移订阅者：降级或恢复的每次转移都回调 (from, to, snapshot)。 */
  private readonly listeners: Array<
    (from: SafeMode, to: SafeMode, snapshot: HealthSnapshot) => void
  > = [];

  /**
   * 装配监督内核；全部阈值可选，缺省即窗口 32 / 降级 0.25 / safe 0.5 / 连续失败 5 次锁定。
   * @param options 监督选项（窗口、阈值、危险工具清单、审计 sink 与会话标识）
   */
  public constructor(options: SupervisorOptions = {}) {
    this.windowSize = Math.max(1, options.windowSize ?? DEFAULT_WINDOW);
    this.degradeThreshold = options.degradeThreshold ?? DEFAULT_DEGRADE;
    this.safeThreshold = options.safeThreshold ?? DEFAULT_SAFE;
    this.lockAfter = Math.max(1, options.lockAfterConsecutiveFailures ?? DEFAULT_LOCK);
    this.hazardous = toSet(options.hazardousTools);
    this.audit = options.audit;
    this.sessionId = options.sessionId;
  }

  /**
   * 上报一次工具执行结果：写入滑动窗口、更新连续失败计数与最近错误，并重算监督模式（可能触发降级转移）。
   *
   * @param tool 工具名。
   * @param outcome 本次执行结果：'success' 或 'failure'。
   * @param error 失败时的错误描述（记入健康快照的 lastError）。
   * @returns 无返回值（重算若触发模式转移会在内部广播）。
   */
  public report(tool: string, outcome: 'success' | 'failure', error?: string): void {
    const stat = this.stats.get(tool) ?? { window: [], consecutiveFailures: 0 };
    const ok = outcome === 'success';
    stat.window.push(ok);
    if (stat.window.length > this.windowSize) {
      stat.window.shift();
    }
    if (ok) {
      stat.consecutiveFailures = 0;
    } else {
      stat.consecutiveFailures += 1;
      if (error !== undefined) {
        stat.lastError = error;
      }
    }
    this.stats.set(tool, stat);
    this.evaluate();
  }

  /**
   * 当前监督模式（nominal → degraded → safe → locked 依次更严）。
   * @returns 当前监督模式。
   */
  public mode(): SafeMode {
    return this.currentMode;
  }

  /**
   * 生成健康快照：按各工具滑动窗口算健康分与成败计数，附当前模式与 ISO 时间戳。
   * @returns 健康快照（当前模式 + 各工具健康条目 + ISO 生成时间）。
   */
  public snapshot(): HealthSnapshot {
    const entries: HealthEntry[] = [];
    for (const [tool, stat] of this.stats) {
      const total = stat.window.length;
      let successes = 0;
      for (const ok of stat.window) {
        if (ok) successes += 1;
      }
      const failures = total - successes;
      entries.push({
        tool,
        health: total === 0 ? 1 : successes / total,
        failures,
        successes,
        lastError: stat.lastError,
      });
    }
    return { mode: this.currentMode, entries, generatedAt: new Date().toISOString() };
  }

  /**
   * 门禁前拦截（fail-closed，优先级高于 Approval/Sandbox）：safe/locked 模式下危险工具一律否决。
   *
   * @param tool 待调用的工具名。
   * @returns 拒绝理由（即否决）；undefined 表示放行，交回后续门禁裁决。
   */
  public intercept(tool: string): string | undefined {
    if (this.currentMode === 'locked') {
      if (this.hazardous.has(tool)) {
        return '监督内核(locked)：危险工具在锁定模式下零越权拒绝';
      }
      // 锁定下仅放行非危险工具，交由 ToolGate 走已收紧的审批/沙箱门禁裁决。
      return undefined;
    }
    if (this.currentMode === 'safe' && this.hazardous.has(tool)) {
      return '监督内核(safe)：危险工具在安全模式下拒绝，零越权';
    }
    return undefined;
  }

  /**
   * 订阅模式变更：每次转移（降级或恢复）触发一次回调，附前后模式与切换后的健康快照。
   *
   * @param cb 转移回调 (from, to, snapshot)。
   * @returns 无返回值。
   */
  public onTransition(cb: (from: SafeMode, to: SafeMode, snapshot: HealthSnapshot) => void): void {
    this.listeners.push(cb);
  }

  /**
   * 主动恢复尝试：仅当全部工具失败率未越 safe 线且无连续失败堆积时回升一级
   * （locked→safe→degraded→nominal），否则保持原模式（fail-closed 偏严）。
   *
   * @returns 恢复后的当前模式（可能未变）。
   */
  public attemptRecovery(): SafeMode {
    if (this.currentMode === 'nominal') {
      return this.currentMode;
    }
    // 仅当全部工具失败率未越 safe 线、且无连续失败堆积时才允许回升一级（fail-closed 偏严）。
    for (const [tool, stat] of this.stats) {
      const total = stat.window.length;
      if (total === 0) continue;
      let successes = 0;
      for (const ok of stat.window) {
        if (ok) successes += 1;
      }
      const failureRate = (total - successes) / total;
      if (failureRate > this.safeThreshold || stat.consecutiveFailures >= this.lockAfter) {
        return this.currentMode;
      }
    }
    const next: SafeMode =
      this.currentMode === 'locked' ? 'safe' : this.currentMode === 'safe' ? 'degraded' : 'nominal';
    this.transition(next);
    return this.currentMode;
  }

  // --- 内部 ---

  /**
   * 取指定工具的统计条目；尚无记录时返回空白条目（空窗口、零连续失败），不写入 map。
   * @param tool 工具名。
   * @returns 该工具的滑动窗口统计（可能为临时空白条目）。
   */
  private statOf(tool: string): ToolStat {
    return this.stats.get(tool) ?? { window: [], consecutiveFailures: 0 };
  }

  /**
   * 依据最新统计重算模式（FDIR 分级降级，fail-closed 单向收紧）：任一工具连续失败达
   * lockAfter 直升 locked；失败率越 safeThreshold 或危险工具出现失败推到 safe；失败率越
   * degradeThreshold 推到 degraded；多工具并存时取最严。只收紧不放松，回升必须走
   * attemptRecovery 逐级进行。
   * @returns 无返回值（模式变化经 transition 生效并广播）。
   */
  private evaluate(): void {
    let next: SafeMode = 'nominal';
    for (const [tool, stat] of this.stats) {
      const total = stat.window.length;
      if (total === 0) continue;
      let successes = 0;
      for (const ok of stat.window) {
        if (ok) successes += 1;
      }
      const failures = total - successes;
      const rate = failures / total;
      const hazardousFailed = this.hazardous.has(tool) && failures > 0;
      if (stat.consecutiveFailures >= this.lockAfter) {
        next = 'locked';
        break;
      }
      if (rate >= this.safeThreshold || hazardousFailed) {
        next = this.raise(next, 'safe');
      } else if (rate >= this.degradeThreshold) {
        next = this.raise(next, 'degraded');
      }
    }
    if (next !== this.currentMode) {
      this.transition(next);
    }
  }

  /**
   * 取两者中更严的模式。
   * @param a 候选模式一。
   * @param b 候选模式二。
   * @returns MODE_ORDER 中更靠后（更严格）的模式。
   */
  private raise(a: SafeMode, b: SafeMode): SafeMode {
    return MODE_ORDER.indexOf(a) >= MODE_ORDER.indexOf(b) ? a : b;
  }

  /**
   * 执行模式转移：更新当前模式、打 warn 日志、（有 sink 时）把前后模式与健康向量写入
   * 审计哈希链，并逐个通知订阅者。
   * @param to 目标模式（与当前相同则直接返回，不产生事件）。
   * @returns 无返回值。
   */
  private transition(to: SafeMode): void {
    const from = this.currentMode;
    if (from === to) return;
    this.currentMode = to;
    const snap = this.snapshot();
    log.warn('supervisor.transition', { from, to, tools: snap.entries.length });
    // 健康向量入审计哈希链（有 sink 时）。
    if (this.audit !== undefined) {
      this.audit.record({
        type: 'supervisor.transition',
        sessionId: this.sessionId,
        detail: { from, to, health: snap.entries },
      });
    }
    for (const cb of this.listeners) {
      cb(from, to, snap);
    }
  }
}
