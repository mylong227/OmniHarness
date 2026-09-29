import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { log } from '../../util/logger.js';
import { HashChain } from '../../util/hashChain.js';

/**
 * @beta
 * 审计事件。
 */
export interface AuditEvent {
  readonly ts?: string | undefined;
  readonly type: string;
  readonly sessionId?: string | undefined;
  readonly actor?: string | undefined;
  readonly detail?: unknown | undefined;
  /** 链序号（从 1 开始递增）。仅哈希链写入后才有值。 */
  readonly seq?: number | undefined;
  /** 上一条记录哈希（首条为创世前驱）。 */
  readonly prev?: string | undefined;
  /** 本条哈希 = SHA256(prev ‖ canonical(本条))。 */
  readonly hash?: string | undefined;
}

/**
 * @beta
 * 链校验结果。
 */
export interface AuditChainReport {
  /**
   * 链完整性：
   * - `true`：链完整且未被篡改；
   * - `false`：被篡改（删除/插入/改内容均可检出）；
   * - `null`：旧格式日志未启用哈希链，不可验证（不等于被篡改）。
   */
  readonly ok: boolean | null;
  /** 参与校验的事件数。 */
  readonly count: number;
  /** 首个断裂处的 seq（ok=false 时有值）。 */
  readonly brokenAt?: number;
  /** 断裂原因（ok=false 时有值）。 */
  readonly reason?: string;
}

/**
 * @beta
 * 审计 sink 选项。
 */
export interface AuditSinkOptions {
  readonly dir?: string;
  readonly path?: string;
}

/**
 * 分隔符：隔离 prev 与正文。
 *
 * 取值是 **NUL**（`\u0000`）：规范正文是 JSON 文本，其控制字符一律被转义为 `\uXXXX`，
 * 故 NUL **不可能**出现在正文里 ⇒ 拼接点绝无歧义。
 *
 * 两条纪律：① **不可改值**——改分隔符＝改历史哈希，已落盘的审计链会当场验签失败；
 * ② 源码里必须写成转义序列（**不要**嵌入裸 NUL 字节），否则文件被工具链当成二进制、
 * diff/编辑器/检索全部失效（本仓实测过：裸 NUL 让 `read` 直接拒读该文件）。
 */
const SEP = '\u0000';

/**
 * 规范化序列化：固定键顺序，保证 record 与 verify 两端算出同一哈希。
 * 不含 prev/hash 自身——它们是被保护的对象，不能进入自己的摘要。
 */

/** 计算链哈希。 */

/**
 * 审计日志单次读回流的上限（字节）：64 MiB。
 *
 * 长运行服务会产生很大的审计日志；`read`/`verify`/`resumeChain` 都依赖把日志读回内存。
 * 若整文件读入，超大日志会撑爆内存。超过此上限即只读**末尾** 64 MiB（审计是 append-only、
 * 尾部才是最新且 `verify`/`resume` 真正需要的部分），并丢弃首条可能被截断的半行。
 */
const MAX_READ_BYTES = 64 * 1024 * 1024;

/**
 * @beta
 * 结构化审计日志 sink（JSONL + **哈希链**，零依赖，fail-closed）。
 *
 * 每条记录带 `seq`/`prev`/`hash`，满足 `hash_n = SHA256(prev_n ‖ canonical(e_n))`。
 * 相比「导出时对整批数据算一次 SHA256」的快照摘要，哈希链能检测出
 * **中间条目被删除、插入或改内容**——快照摘要做不到，那正是合规场景的硬伤。
 *
 * 链状态在构造时从文件末尾恢复，因此跨进程重启可续链（而非另起一条）。
 */
export class AuditSink {
  /** 审计日志落盘目标（path 优先，其次 dir/audit.log；未配置时 record 退化为 no-op）。 */
  private readonly target: string | undefined;
  /** 已写入的最大链序号。 */
  private seq = 0;
  /** 上一条记录哈希。 */
  private prev = HashChain.GENESIS;

  /**
   * @param options 落盘目标：`path` 为完整文件路径，`dir` 为目录（固定写 `audit.log`）；两者都缺省时不落盘（record 为 no-op）。
   *   构造即建目录、建空文件并从文件末尾恢复链状态，保证跨进程重启可续链。
   */
  public constructor(options: AuditSinkOptions = {}) {
    if (options.path !== undefined) {
      this.target = options.path;
    } else if (options.dir !== undefined) {
      this.target = join(options.dir, 'audit.log');
    } else {
      this.target = undefined;
    }
    if (this.target !== undefined) {
      const dir = dirname(this.target);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      if (!existsSync(this.target)) {
        writeFileSync(this.target, '', { flag: 'a' });
      }
      this.resumeChain();
    }
  }

  /**
   * 记录事件（未配置目标时 no-op）。返回写入的链序号，未落盘时为 undefined。
   * @param entry 待入链的审计事件
   * @returns 本次写入的链序号（从 1 递增）；未配置落盘目标时为 undefined。
   */
  public record(entry: AuditEvent): number | undefined {
    if (this.target === undefined) return undefined;
    const ts = entry.ts || new Date().toISOString();
    const seq = this.seq + 1;
    const prev = this.prev;
    const hash = HashChain.hash(prev, AuditSink.canonicalOf(ts, entry, seq), SEP);
    const line = JSON.stringify({
      ts,
      type: entry.type,
      sessionId: entry.sessionId,
      actor: entry.actor,
      detail: entry.detail,
      seq,
      prev,
      hash,
    });
    appendFileSync(this.target, line + '\n');
    this.seq = seq;
    this.prev = hash;
    log.debug('audit.record', { type: entry.type, seq });
    return seq;
  }

  /**
   * 读回落盘日志（未配置目标或文件不存在时返回 []；坏行跳过，fail-closed）。
   * @returns 按写入顺序排列的事件数组（旧格式无链字段的记录原样包含在内）。
   */
  public read(): AuditEvent[] {
    if (this.target === undefined || !existsSync(this.target)) return [];
    const content = AuditSink.readCapped(this.target);
    const out: AuditEvent[] = [];
    for (const raw of content.split('\n')) {
      const line = raw.trim();
      if (line === '') continue;
      try {
        out.push(JSON.parse(line) as AuditEvent);
      } catch {
        // 跳过坏行，不中断整次读取
      }
    }
    return out;
  }

  /**
   * 有界读回审计日志原文：文件超过 {@link MAX_READ_BYTES} 时只读末尾该字节数，
   * 丢弃首条可能被截断的半行（避免在超大日志上把内存撑爆）。
   * @param path 审计日志文件路径。
   * @returns 日志文本（可能只是尾部）。
   */
  private static readCapped(path: string): string {
    const size = statSync(path).size;
    if (size <= MAX_READ_BYTES) {
      return readFileSync(path, 'utf8');
    }
    const start = size - MAX_READ_BYTES;
    const fd = openSync(path, 'r');
    try {
      const buf = Buffer.alloc(MAX_READ_BYTES);
      readSync(fd, buf, 0, MAX_READ_BYTES, start);
      const text = buf.toString('utf8');
      // 首段可能是半行（从中间字节切开的），丢弃直到第一个换行，避免解析出坏 JSON。
      const nl = text.indexOf('\n');
      return nl >= 0 ? text.slice(nl + 1) : '';
    } finally {
      closeSync(fd);
    }
  }

  /**
   * 校验哈希链完整性：顺序、前驱指针、逐条哈希三重比对。
   *
   * 三类篡改均可检出：
   * - **改内容** → 重算 hash 不匹配；
   * - **删条目** → seq 与位置不符；
   * - **插条目** → seq 与位置不符，且后续 prev 指针断裂。
   *
   * @returns 链校验报告：ok=false 时给出首个断裂位置与原因；旧格式日志（无链字段）ok=null，表示不可验证而非被篡改。
   */
  public verify(): AuditChainReport {
    const events = this.read();
    if (events.length === 0) {
      const okResult: AuditChainReport = { ok: true, count: 0 };
      return okResult;
    }
    // 旧格式日志：所有事件均无链字段 → 未启用哈希链，不可验证（不等于被篡改）。
    const hasChain = events.some(
      (e) => typeof e.seq === 'number' && typeof e.hash === 'string' && typeof e.prev === 'string',
    );
    if (!hasChain) {
      const legacy: AuditChainReport = {
        ok: null,
        count: events.length,
        reason: '旧格式日志：未启用哈希链，无法校验完整性（非篡改）',
      };
      log.debug('audit.verify.legacy', { count: events.length });
      return legacy;
    }
    let prev = HashChain.GENESIS;
    let result: AuditChainReport = { ok: true, count: events.length };
    for (let i = 0; i < events.length; i += 1) {
      const e = events[i];
      if (e === undefined) continue;
      const position = i + 1;
      if (typeof e.seq !== 'number' || typeof e.hash !== 'string' || typeof e.prev !== 'string') {
        result = {
          ok: false,
          count: events.length,
          brokenAt: position,
          reason: `第 ${position} 条缺少链字段（seq/prev/hash），疑似旧格式或被剥离`,
        };
        break;
      }
      if (e.seq !== position) {
        result = {
          ok: false,
          count: events.length,
          brokenAt: e.seq,
          reason: `第 ${position} 条 seq=${e.seq} 与位置不符，疑似条目被删除或插入`,
        };
        break;
      }
      if (e.prev !== prev) {
        result = {
          ok: false,
          count: events.length,
          brokenAt: e.seq,
          reason: `第 ${e.seq} 条 prev 与前一条 hash 不匹配，链条断裂`,
        };
        break;
      }
      const expected = HashChain.hash(prev, AuditSink.canonicalOf(e.ts ?? '', e, e.seq), SEP);
      if (e.hash !== expected) {
        result = {
          ok: false,
          count: events.length,
          brokenAt: e.seq,
          reason: `第 ${e.seq} 条 hash 不匹配，内容（含时间戳）被篡改`,
        };
        break;
      }
      prev = e.hash;
    }
    if (result.ok === false) {
      log.warn('audit.verify.failed', { brokenAt: result.brokenAt, reason: result.reason });
    }
    return result;
  }

  /**
   * 从文件末尾恢复链状态，使跨进程重启能续链而非另起一条。
   * @returns 无返回值。
   */
  private resumeChain(): void {
    const events = this.read();
    const last = events[events.length - 1];
    if (last === undefined) return;
    if (typeof last.seq === 'number' && typeof last.hash === 'string') {
      this.seq = last.seq;
      this.prev = last.hash;
    }
  }
  /**
   * canonicalOf (internal helper hoisted into AuditSink).
   * @param {string} ts
   * @param {AuditEvent} entry
   * @param {number} seq
   * @returns {string}
   */
  private static canonicalOf(ts: string, entry: AuditEvent, seq: number): string {
    return JSON.stringify({
      ts,
      type: entry.type,
      sessionId: entry.sessionId,
      actor: entry.actor,
      detail: entry.detail,
      seq,
    });
  }
}
