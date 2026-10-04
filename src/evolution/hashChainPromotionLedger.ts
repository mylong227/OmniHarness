/**
 * 哈希链晋升台账（GEE Kernel v1 · ⑤ snapshotBefore 环 + 第七环「回滚」的存储面，ADR-0008）。
 *
 * 「治理化自进化」的机制本体：**无快照不晋升、按 seq 可还原**——外部自进化系统
 * （DGM / OpenEvolve / ShinkaEvolve）均无「晋升可还原」语义，本台账把目标架构不变式
 * S3（无快照不晋升、无台账不生效）钉成机制。
 *
 * 链算法复用 `util/hashChain`（与审计链 / 遥测链同源算法，防口径漂移），但**语义独立**：
 * 本链记「技能表状态变化」的操作史（snapshot / promote / rollback），与「人/系统动作」
 * 证据链（AuditSink）互不污染（ADR-0008 替代方案决策）。
 *
 * **分隔符 `'|'`（刻意区别于两条既有链）**：审计链 NUL、遥测链空格（均为历史既定、不可改）；
 * 本链无历史包袱，取 `'|'` 保持三条链的哈希空间互不相干。golden 哈希由判据测试钉死。
 *
 * 落盘：JSONL append-only（每行一条 `PromotionLedgerEntry`），构造时从文件末尾续链，
 * 跨进程重启可续。**篡改检出**：载入后 `verify()` 重算全链比对——链断裂（中间条目被改/删）
 * 时 `verify()` 红，且**一切写入抛错**（fail-closed：断链上追加 = 制造第二本假账）。
 *
 * 观测：每次入链发 `evolution.ledger.appended`（seq/action），回滚发 `evolution.ledger.rollback`
 * （seq→快照 / 还原条数）——观测回调可注入、失败只告警（观测不是治理边界）。
 *
 * @maturity L1 — 快照/还原/篡改检出/重启续链判据钉死；多进程并发写未处理（单进程口径）
 * @maturityEvidence tests/unit/hashChainPromotionLedger.test.ts
 */
import { existsSync, mkdirSync, appendFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { HashChain } from '../util/hashChain.js';
import { log } from '../util/logger.js';
import type { Skill } from '../skill/skill.js';
import type {
  PromotionLedgerEntry,
  PromotionLedgerPort,
  PromotionLedgerVerifyReport,
  PromotionRecord,
  SkillRestorePlan,
} from '../ports/runtime/evolution.js';

/** 链分隔符（见模块注释：与审计 NUL / 遥测空格刻意区分）。 */
const SEP = '|';

/**
 * 台账观测回调（EVOLVIX_SPEC §观测行 声明的 `evolution.ledger.*` 注入点）：
 * 空实现即静音；缺省写共享 logger。观测**尽力而为**——回调抛错不得连累治理写入。
 */
export type LedgerObserver = (msg: string, fields: Record<string, unknown>) => void;

/** 台账选项。 */
export interface HashChainPromotionLedgerOptions {
  /** 直接指定落盘文件路径（优先于 `dir`；缺省两者 = 纯内存链，不落盘）。 */
  readonly path?: string | undefined;
  /** 落盘目录（落盘为 `<dir>/ledger.jsonl`）。 */
  readonly dir?: string | undefined;
  /** ISO 时间戳注入点（缺省取当前时间；测试注入固定时钟保证确定性）。 */
  readonly now?: (() => string) | undefined;
  /** 观测回调（缺省 = 共享 logger；测试注入采集器以钉死观测行口径）。 */
  readonly observer?: LedgerObserver | undefined;
}

/** 待入链条目草稿（链字段由台账计算）。 */
interface EntryDraft {
  readonly ts: string;
  readonly action: PromotionLedgerEntry['action'];
  readonly skills?: readonly Skill[] | undefined;
  readonly promoted?: { readonly name: string; readonly source: string } | undefined;
  readonly rollbackTo?: number | undefined;
}

/** 哈希链晋升台账：JSONL 追加 + 快照/晋升/回滚三型条目 + 篡改检出。 */
export class HashChainPromotionLedger implements PromotionLedgerPort {
  /** 落盘路径（undefined = 纯内存链）。 */
  private readonly path: string | undefined;
  /** ISO 时间戳注入点。 */
  private readonly now: () => string;
  /** 观测回调（`evolution.ledger.*` 观测行的去向）。 */
  private readonly observe: LedgerObserver;
  /** 内存镜像（载入 + 追加；落盘为逐条 append）。 */
  private readonly entries: PromotionLedgerEntry[] = [];
  /** 载入时检出的断链（断链上的一切写入 fail-closed 抛错）。 */
  private broken: PromotionLedgerVerifyReport | undefined;

  /**
   * @param opts 落盘路径 / 目录 / 时间戳注入点 / 观测回调（缺省各取保守默认）
   */
  public constructor(opts: HashChainPromotionLedgerOptions = {}) {
    this.now = opts.now ?? ((): string => new Date().toISOString());
    this.observe = opts.observer ?? ((msg, fields) => log.info(msg, fields));
    this.path = opts.path ?? (opts.dir !== undefined ? join(opts.dir, 'ledger.jsonl') : undefined);
    if (this.path !== undefined && existsSync(this.path)) {
      this.load(this.path);
    }
  }

  /**
   * 晋升前快照：当前技能表全量入链（深拷贝；此后外部改动不影响快照）。
   * @param skills 当前技能表（如 `SkillPort.list()`）
   * @returns 该快照条目的 seq（回滚定位锚点）
   * @throws 链已断裂时抛错（fail-closed，断链上不写）
   */
  public snapshotBefore(skills: readonly Skill[]): number {
    return this.emit({ ts: this.now(), action: 'snapshot', skills: structuredClone(skills) });
  }

  /**
   * 追加晋升记录。
   * @param promotion 晋升记录（技能名 + 来源）
   * @returns 该条目的 seq
   * @throws 链已断裂时抛错（fail-closed）
   */
  public append(promotion: PromotionRecord): number {
    return this.emit({
      ts: promotion.ts ?? this.now(),
      action: 'promote',
      promoted: { name: promotion.name, source: promotion.source },
    });
  }

  /**
   * 还原到指定快照：定位 `seq` 处（或其之前最近）的 snapshot 条目，产出还原计划
   * （目标技能表全量深副本），并把本次回滚本身入链（治理事件不隐身）。
   * @param seq 回滚目标快照的 seq
   * @returns 还原计划（apply 由调用方执行：表内 replace、快照外新增者 remove）
   * @throws 链已断裂，或定位不到 snapshot（seq 非法 / 链中无快照）时抛错（fail-closed，绝不静默空还原）
   */
  public rollback(seq: number): SkillRestorePlan {
    let snapshot: PromotionLedgerEntry | undefined;
    for (const entry of this.entries) {
      if (entry.seq > seq) break;
      if (entry.action === 'snapshot') snapshot = entry;
    }
    if (snapshot === undefined) {
      throw new Error(`rollback 定位不到快照（seq=${seq}，链中无 ≤seq 的 snapshot 条目）`);
    }
    const skills = structuredClone(snapshot.skills ?? []);
    this.emit({ ts: this.now(), action: 'rollback', rollbackTo: snapshot.seq, skills });
    this.notify('evolution.ledger.rollback', {
      seq: snapshot.seq,
      rollbackTo: snapshot.seq,
      restored: skills.length,
    });
    return { seq: snapshot.seq, skills };
  }

  /**
   * 链完整性校验（重算全链哈希 + 前驱连续性比对）。
   * @returns 完整性报告（空链恒 ok；载入时检出截断/断链则如实回报该状态）
   */
  public verify(): PromotionLedgerVerifyReport {
    if (this.broken !== undefined) {
      return this.broken;
    }
    let prev: string = HashChain.GENESIS;
    for (const entry of this.entries) {
      if (entry.prev !== prev) {
        return {
          ok: false,
          count: this.entries.length,
          brokenAt: entry.seq,
          reason: `前驱不连续：seq=${entry.seq} 的 prev ≠ 上一条 hash`,
        };
      }
      const expected = HashChain.hash(prev, HashChainPromotionLedger.canonicalOf(entry), SEP);
      if (entry.hash !== expected) {
        return {
          ok: false,
          count: this.entries.length,
          brokenAt: entry.seq,
          reason: `哈希不匹配：seq=${entry.seq} 内容被篡改或 hash 字段损坏`,
        };
      }
      prev = entry.hash;
    }
    return { ok: true, count: this.entries.length };
  }

  /**
   * 规范化正文（固定键序，不含 prev/hash 自身——它们是被保护对象）。
   * @param entry 台账条目
   * @returns 可参与哈希的规范化 JSON 字符串
   */
  private static canonicalOf(entry: PromotionLedgerEntry): string {
    return JSON.stringify({
      ts: entry.ts,
      action: entry.action,
      skills: entry.skills ?? null,
      promoted: entry.promoted ?? null,
      rollbackTo: entry.rollbackTo ?? null,
    });
  }

  /**
   * 入链一条草稿：算 seq/prev/hash → 内存镜像 → 逐条 append 落盘。
   * @param draft 条目草稿
   * @returns 该条目 seq
   * @throws 链已断裂，或落盘失败时抛错（fail-closed：写不进盘的台账视为不可用）
   */
  private emit(draft: EntryDraft): number {
    if (this.broken !== undefined) {
      throw new Error(`台账链已断裂（seq=${this.broken.brokenAt}），fail-closed 拒绝写入`);
    }
    const seq = this.entries.length + 1;
    const prev = this.entries.at(-1)?.hash ?? HashChain.GENESIS;
    const base: PromotionLedgerEntry = {
      seq,
      ts: draft.ts,
      action: draft.action,
      skills: draft.skills,
      promoted: draft.promoted,
      rollbackTo: draft.rollbackTo,
      prev,
      hash: '',
    };
    // 规范化正文不含 prev/hash 自身（被保护对象）；hash 空串占位不参与 canonical（字段被排除）。
    const entry: PromotionLedgerEntry = {
      ...base,
      hash: HashChain.hash(prev, HashChainPromotionLedger.canonicalOf(base), SEP),
    };
    this.entries.push(entry);
    this.flush(entry);
    this.notify('evolution.ledger.appended', { seq, action: entry.action });
    return seq;
  }

  /**
   * 发观测行（尽力而为：回调抛错只告警，绝不连累治理写入——观测不是治理边界）。
   * @param msg 观测行名（`evolution.ledger.*`）
   * @param fields 观测字段
   * @returns 无返回值（void）
   */
  private notify(msg: string, fields: Record<string, unknown>): void {
    try {
      this.observe(msg, fields);
    } catch (err) {
      log.warn('evolution.ledger.observe.failed', { msg, error: String(err) });
    }
  }

  /**
   * 逐条追加落盘（目录不存在则创建）。
   * @param entry 已入链条目
   * @returns 无返回值（void）
   */
  private flush(entry: PromotionLedgerEntry): void {
    if (this.path === undefined) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      appendFileSync(this.path, `${JSON.stringify(entry)}\n`, 'utf8');
    } catch (err) {
      // 回滚内存镜像：未落盘成功的条目不得留在链上（内存/磁盘恒一致）。
      this.entries.pop();
      throw new Error(`台账落盘失败：${String(err)}`);
    }
  }

  /**
   * 从文件载入历史链（逐行解析 + 全链校验；断链**不抛**，置 `broken` 后由 verify 暴露、写入拦截）。
   * @param path 台账文件路径
   * @returns 无返回值（void）
   */
  private load(path: string): void {
    const lines = readFileSync(path, 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0);
    const loaded: PromotionLedgerEntry[] = [];
    for (const line of lines) {
      try {
        loaded.push(JSON.parse(line) as PromotionLedgerEntry);
      } catch {
        // 截断/手改：保留可解析前缀（供取证），置 broken 后由 verify() 暴露、写入拦截——
        // 绝不静默重置历史（那等于帮篡改者销账）。
        this.broken = {
          ok: false,
          count: loaded.length,
          brokenAt: loaded.at(-1)?.seq,
          reason: `台账第 ${loaded.length + 1} 行非 JSON（文件被截断或手改）`,
        };
        this.entries.push(...loaded);
        return;
      }
    }
    this.entries.push(...loaded);
    const report = this.verify();
    if (!report.ok) {
      this.broken = report;
    }
  }
}
