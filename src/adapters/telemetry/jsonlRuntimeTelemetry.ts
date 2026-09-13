import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import type {
  RuntimeObservation,
  RuntimeTelemetryInput,
  RuntimeTelemetryPort,
  TelemetryChainReport,
} from '../../ports/runtime/runtimeTelemetry.js';

/** 创世前驱哈希：首条记录的 prev，使首条也纳入链校验。 */
const GENESIS = '0'.repeat(64);

/** 分隔符：隔离 prev 与正文，避免拼接歧义。 */
const SEP = ' ';

/** 规范化序列化：固定键顺序，保证 record 与 verify 两端算出同一哈希。
 * 不含 prev/hash 自身——它们是被保护对象，不能进入自己的摘要。
 * @param ts 记录时间戳（ISO 字符串）。
 * @param entry 观测内容（含已确定的 id）。
 * @param seq 链序号。
 * @returns 可参与哈希的规范化 JSON 字符串。
 */
function canonicalOf(
  ts: string,
  entry: RuntimeTelemetryInput & { id: string },
  seq: number,
): string {
  return JSON.stringify({
    id: entry.id,
    ts,
    kind: entry.kind,
    operator: entry.operator,
    configSnapshot: entry.configSnapshot,
    metrics: entry.metrics,
    verdict: entry.verdict,
    provenance: entry.provenance,
    seq,
  });
}

/** 计算链哈希。
 * @param prev 前一条记录哈希（首条为 GENESIS 全零）。
 * @param canonical 规范化正文（{@link canonicalOf} 的输出）。
 * @returns SHA256(prev ‖ ' ' ‖ canonical) 的 hex 摘要。
 */
function hashOf(prev: string, canonical: string): string {
  return createHash('sha256').update(prev).update(SEP).update(canonical).digest('hex');
}

/** JSONL 长期运行遥测存储选项。 */
export interface JsonlRuntimeTelemetryOptions {
  /** 直接指定落盘文件路径。 */
  readonly path?: string;
  /** 指定目录（落盘为 `<dir>/runtime-telemetry.log`）。 */
  readonly dir?: string;
}

/**
 * 长期运行遥测 sink（I-P4-3，零依赖、append-only JSONL + 哈希链、fail-closed）。
 *
 * 每条记录带 `seq`/`prev`/`hash`，满足 `hash_n = SHA256(prev_n ‖ canonical(e_n))`。
 * 链状态在构造时从文件末尾恢复，跨进程重启可续链。
 *
 * 未配置目标（既无 `path` 也无 `dir`）时：`record` 返回 undefined（no-op）、
 * `read` 返回 []、`verify` 返回 `{ ok: true, count: 0 }`——即零破坏旁路。
 */
export class JsonlRuntimeTelemetry implements RuntimeTelemetryPort {
  /** 端口名：JSONL 遥测 sink 标识，与 RuntimeTelemetryPort 契约的命名空间一致。 */
  public readonly name = 'jsonl-runtime-telemetry';
  /** 落盘目标文件路径（未配置 path/dir 时为 undefined，即零破坏旁路模式）。 */
  private readonly target: string | undefined;
  /** 已写入的最大链序号。 */
  private seq = 0;
  /** 上一条记录哈希。 */
  private prev = GENESIS;

  /**
   * 构造遥测 sink：解析落盘目标（path 优先，其次 dir/runtime-telemetry.log）、
   * 确保目录与文件存在并从文件末尾恢复链状态。
   * @param options 落盘位置选项；两个都缺省时进入 no-op 旁路。
   */
  public constructor(options: JsonlRuntimeTelemetryOptions = {}) {
    if (options.path !== undefined) {
      this.target = options.path;
    } else if (options.dir !== undefined) {
      this.target = join(options.dir, 'runtime-telemetry.log');
    } else {
      this.target = undefined;
    }
    if (this.target !== undefined) {
      const dir = dirname(this.target);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      if (!existsSync(this.target)) writeFileSync(this.target, '', { flag: 'a' });
      this.resumeChain();
    }
  }

  /** 记录一条观测（未配置目标时 no-op）。返回链序号。
   * @param obs 观测内容（id/ts 缺省时自动补 UUID 与当前时间）。
   * @returns 本条记录的链序号（seq）；旁路模式下为 undefined。
   */
  public record(obs: RuntimeTelemetryInput): number | undefined {
    if (this.target === undefined) return undefined;
    const id = obs.id || randomUUID();
    const ts = obs.ts || new Date().toISOString();
    const seq = this.seq + 1;
    const prev = this.prev;
    const hash = hashOf(prev, canonicalOf(ts, { ...obs, id }, seq));
    const line = JSON.stringify({
      id,
      ts,
      kind: obs.kind,
      operator: obs.operator,
      configSnapshot: obs.configSnapshot,
      metrics: obs.metrics,
      verdict: obs.verdict,
      provenance: obs.provenance,
      seq,
      prev,
      hash,
    });
    appendFileSync(this.target, line + '\n');
    this.seq = seq;
    this.prev = hash;
    return seq;
  }

  /** 读取全部观测（坏行跳过，fail-closed）。
   * @returns 按文件行序解析出的观测列表；旁路模式或文件不存在时为空数组。
   */
  public read(): readonly RuntimeObservation[] {
    if (this.target === undefined || !existsSync(this.target)) return [];
    const content = readFileSync(this.target, 'utf8');
    const out: RuntimeObservation[] = [];
    for (const raw of content.split('\n')) {
      const line = raw.trim();
      if (line === '') continue;
      try {
        out.push(JSON.parse(line) as RuntimeObservation);
      } catch {
        // 跳过坏行，不中断整次读取
      }
    }
    return out;
  }

  /**
   * 校验哈希链完整性：顺序、前驱指针、逐条哈希三重比对。
   * 改内容 / 删条目 / 插条目均可检出。
   * @returns 链校验报告：ok=true 完整；ok=false 附 brokenAt 与原因；ok=null 为旧格式不可校验；
   *          空文件视为 ok（count=0）。
   */
  public verify(): TelemetryChainReport {
    const events = this.read();
    if (events.length === 0) return { ok: true, count: 0 };
    const hasChain = events.some(
      (e) => typeof e.seq === 'number' && typeof e.hash === 'string' && typeof e.prev === 'string',
    );
    if (!hasChain) {
      return {
        ok: null,
        count: events.length,
        reason: '旧格式日志：未启用哈希链，无法校验（非篡改）',
      };
    }
    let prev = GENESIS;
    for (let i = 0; i < events.length; i += 1) {
      const e = events[i];
      if (e === undefined) continue;
      const position = i + 1;
      if (typeof e.seq !== 'number' || typeof e.hash !== 'string' || typeof e.prev !== 'string') {
        return {
          ok: false,
          count: events.length,
          brokenAt: position,
          reason: `第 ${position} 条缺少链字段`,
        };
      }
      if (e.seq !== position) {
        return {
          ok: false,
          count: events.length,
          brokenAt: e.seq,
          reason: `第 ${position} 条 seq 与位置不符`,
        };
      }
      if (e.prev !== prev) {
        return {
          ok: false,
          count: events.length,
          brokenAt: e.seq,
          reason: `第 ${e.seq} 条 prev 与前一条 hash 不匹配`,
        };
      }
      const expected = hashOf(prev, canonicalOf(e.ts ?? '', e, e.seq));
      if (e.hash !== expected) {
        return {
          ok: false,
          count: events.length,
          brokenAt: e.seq,
          reason: `第 ${e.seq} 条 hash 不匹配，内容被篡改`,
        };
      }
      prev = e.hash;
    }
    return { ok: true, count: events.length };
  }

  /** 从文件末尾恢复链状态，跨进程重启续链。
   * @returns 无返回值。
   */
  private resumeChain(): void {
    const events = this.read();
    const last = events[events.length - 1];
    if (last !== undefined && typeof last.seq === 'number' && typeof last.hash === 'string') {
      this.seq = last.seq;
      this.prev = last.hash;
    }
  }
}
