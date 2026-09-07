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

export class SupervisorKernel implements SupervisorPort {
  private readonly windowSize: number;
  private readonly degradeThreshold: number;
  private readonly safeThreshold: number;
  private readonly lockAfter: number;
  private readonly hazardous: ReadonlySet<string>;
  private readonly audit?: AuditSinkLike;
  private readonly sessionId?: string;

  private readonly stats = new Map<string, ToolStat>();
  private currentMode: SafeMode = 'nominal';
  private readonly listeners: Array<
    (from: SafeMode, to: SafeMode, snapshot: HealthSnapshot) => void
  > = [];

  constructor(options: SupervisorOptions = {}) {
    this.windowSize = Math.max(1, options.windowSize ?? DEFAULT_WINDOW);
    this.degradeThreshold = options.degradeThreshold ?? DEFAULT_DEGRADE;
    this.safeThreshold = options.safeThreshold ?? DEFAULT_SAFE;
    this.lockAfter = Math.max(1, options.lockAfterConsecutiveFailures ?? DEFAULT_LOCK);
    this.hazardous = toSet(options.hazardousTools);
    this.audit = options.audit;
    this.sessionId = options.sessionId;
  }

  report(tool: string, outcome: 'success' | 'failure', error?: string): void {
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

  mode(): SafeMode {
    return this.currentMode;
  }

  snapshot(): HealthSnapshot {
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

  intercept(tool: string): string | undefined {
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

  onTransition(cb: (from: SafeMode, to: SafeMode, snapshot: HealthSnapshot) => void): void {
    this.listeners.push(cb);
  }

  attemptRecovery(): SafeMode {
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

  private statOf(tool: string): ToolStat {
    return this.stats.get(tool) ?? { window: [], consecutiveFailures: 0 };
  }

  /** 依据最新统计重算模式（FDIR 分级降级，fail-closed 单向收紧）。 */
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

  /** 取两者中更严的模式。 */
  private raise(a: SafeMode, b: SafeMode): SafeMode {
    return MODE_ORDER.indexOf(a) >= MODE_ORDER.indexOf(b) ? a : b;
  }

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
