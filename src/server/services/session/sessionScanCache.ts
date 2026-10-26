/**
 * 会话存档的**逐文件解析 + 有界缓存**（`list` 与 `usage` 共用）。
 *
 * ## 为什么独立成模块（2026-10-18）
 *
 * 会话列表与 token 用量都要把**每个** `.jsonl` 读一遍并逐行解析，而 RPC 是同步执行的：
 * 本机 134 个会话（1.6 MB）实测**列表 47.5 ms / 用量同量级**，会话上千或挂网络盘时就是几百毫秒，
 * 这段时间 SSE 心跳与其它请求全部停摆。
 *
 * 列表刷新与指标刷新里，绝大多数文件**没变**——按 `(mtimeMs, size)` 缓存解析结果即可：
 * 追加事件会改 mtime ⇒ 自动失效，不存在陈旧读。两个调用点共用同一份缓存的实现，
 * 也把"解析循环 + 缓存判据"从 `SessionArchive` 里挪走（那个类已到上帝类阈值边缘）。
 *
 * ## 2026-10-25：列表摘要走旁路
 *
 * `readSummary` 先读 `<sid>.jsonl.summary.json`（几百字节，带 `.jsonl` 字节数校验）：
 * 命中即**完全不读 `.jsonl`**；缺失/过期才逐行解析并异步回写。`usage` 仍整档解析
 * （它要逐条聚合 token，无法用摘要替代）。旁路由 `JsonlStorage.save` 与回合末补写。
 *
 * ## 缓存边界
 *
 * 有界：超过 4096 条整体清空重建（极端多会话场景不会无限吃内存）。
 * 只缓存**解析结果**，不缓存文件内容；返回值是深拷贝过的普通对象/Map，调用方改不到缓存。
 */

import { readFile, stat } from 'node:fs/promises';
import { SessionFileScanner } from './sessionFileScanner.ts';
import { SessionSummaryBuilder, type SessionSummary } from '../../../util/sessionSummary.ts';
import { readSessionSummary, writeSessionSummary } from '../../../util/sessionSummarySidecar.ts';

export type { SessionSummary } from '../../../util/sessionSummary.ts';

/** 单个模型的 token 统计。 */
export interface ModelUsage {
  /** 调用次数。 */
  readonly calls: number;
  /** prompt token 数。 */
  readonly prompt: number;
  /** completion token 数。 */
  readonly completion: number;
  /** prompt + completion。 */
  readonly total: number;
}

/** 单个会话存档的用量汇总。 */
export interface UsageSummary {
  /** 本文件的 model 事件条数。 */
  readonly calls: number;
  /** 本文件的 token 总量。 */
  readonly total: number;
  /** 逐模型统计（只读副本）。 */
  readonly byModel: ReadonlyMap<string, ModelUsage>;
}

/** 读取文件 `mtimeMs` 与大小的结果（缓存键）。 */
interface FileStamp {
  readonly mtimeMs: number;
  readonly size: number;
}

/**
 * 有界 `(mtimeMs,size)` 解析缓存。
 *
 * 只做一件事：文件戳没变就复用上次的解析结果，变了就重新 `load()`。
 * `load()` 返回 `undefined` 表示"解析不出有效结果"（文件不可读/空），此时不写缓存。
 */
class FileParseCache<V> {
  /** 文件路径 → 上次解析结果与它的文件戳。 */
  private readonly entries = new Map<string, { stamp: FileStamp; value: V }>();
  /** 同一文件的并发加载去重（list 与 usage 可能同时扫到同一个文件）。 */
  private readonly inflight = new Map<string, Promise<V | undefined>>();

  /**
   * @param maxEntries 最多保留的条目数（超过即整体清空重建）
   */
  public constructor(private readonly maxEntries = 4096) {}

  /**
   * 取文件戳；文件不可读时 `undefined`。
   * @param file 文件路径
   * @returns 文件戳
   */
  private static async stampOf(file: string): Promise<FileStamp | undefined> {
    try {
      const st = await stat(file);
      return { mtimeMs: st.mtimeMs, size: st.size };
    } catch {
      return undefined;
    }
  }

  /**
   * 命中缓存则直接返回；否则调用 `load(stamp)` 解析并写回缓存。
   * @param file 文件路径
   * @param load 解析函数（仅在未命中时调用；拿到文件戳用于校验旁路摘要）
   * @returns 解析结果与文件戳；文件不可读或解析失败时为 `undefined`
   */
  public async getOrLoad(
    file: string,
    load: (stamp: FileStamp) => Promise<V | undefined>,
  ): Promise<{ value: V; mtimeMs: number } | undefined> {
    const stamp = await FileParseCache.stampOf(file);
    if (stamp === undefined) return undefined;
    const hit = this.entries.get(file);
    if (hit !== undefined && hit.stamp.mtimeMs === stamp.mtimeMs && hit.stamp.size === stamp.size) {
      return { value: hit.value, mtimeMs: stamp.mtimeMs };
    }
    // 并发去重：同一文件同时被 list 与 usage 扫到时不重复读盘/解析。
    const inflight = this.inflight.get(file);
    let value: V | undefined;
    if (inflight !== undefined) {
      value = await inflight;
    } else {
      const task = load(stamp);
      this.inflight.set(file, task);
      try {
        value = await task;
      } finally {
        this.inflight.delete(file);
      }
    }
    if (value === undefined) return undefined;
    if (this.entries.size >= this.maxEntries) this.entries.clear();
    this.entries.set(file, { stamp, value });
    return { value, mtimeMs: stamp.mtimeMs };
  }
}

/** 空用量（文件不可读时的稳定返回，调用方无需判空）。 */
const EMPTY_USAGE: UsageSummary = { calls: 0, total: 0, byModel: new Map() };

/** 会话存档扫描器：解析 `list` 摘要与 `usage` 统计，并缓存结果。 */
export class SessionScanCache {
  /** 摘要缓存。 */
  private readonly listCache = new FileParseCache<SessionSummary>();
  /** 用量缓存。 */
  private readonly usageCache = new FileParseCache<UsageSummary>();

  /**
   * 读会话摘要（带缓存）。
   * @param file 存档绝对路径
   * @returns 摘要与文件 mtime；不可读时为 `undefined`
   */
  public async readSummary(
    file: string,
  ): Promise<{ value: SessionSummary; mtimeMs: number } | undefined> {
    return this.listCache.getOrLoad(file, (stamp) => SessionScanCache.parseSummary(file, stamp));
  }

  /**
   * 读单会话用量（带缓存）。
   * @param file 存档绝对路径
   * @returns 用量汇总（不可读时为空表，不抛错）
   */
  public async readUsage(file: string): Promise<UsageSummary> {
    const hit = await this.usageCache.getOrLoad(file, () => SessionScanCache.parseUsage(file));
    return hit?.value ?? EMPTY_USAGE;
  }

  /**
   * 解析摘要：优先读**旁路摘要**，失效才整档逐行解析。
   *
   * 2026-10-25：`.jsonl.summary.json` 的 `size` 与当前文件戳一致时直接返回，完全不读 `.jsonl`。
   * 旁路缺失/过期则按原口径逐行解析，并**尽力**回写旁路（失败只影响下次性能，不影响结果）。
   *
   * @param file 存档绝对路径
   * @param stamp 当前文件戳（大小用于校验旁路）
   * @returns 摘要；不可读时 `undefined`
   */
  private static async parseSummary(
    file: string,
    stamp: { readonly mtimeMs: number; readonly size: number },
  ): Promise<SessionSummary | undefined> {
    const sidecar = await readSessionSummary(file);
    if (sidecar !== undefined && sidecar.size === stamp.size) {
      return sidecar.summary;
    }
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch {
      return undefined;
    }
    const builder = new SessionSummaryBuilder();
    for (const line of text.split('\n')) {
      const event = SessionFileScanner.parseLine(line);
      if (event !== undefined) builder.add(event);
    }
    const summary = builder.build();
    // 不 await：列表刷新不该为「优化旁路」多付 409 次写；失败下次解析会重试。
    void writeSessionSummary(file, stamp.size, summary).catch(() => undefined);
    return summary;
  }

  /**
   * 解析用量：聚合 `type='model'` 事件的 `usage.promptTokens/completionTokens`。
   * @param file 存档绝对路径
   * @returns 用量汇总；不可读时 `undefined`
   */
  private static async parseUsage(file: string): Promise<UsageSummary | undefined> {
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch {
      return undefined;
    }
    const byModel = new Map<string, ModelUsage>();
    let calls = 0;
    let total = 0;
    for (const line of text.split('\n')) {
      const ev = SessionFileScanner.parseLine(line);
      if (ev?.type !== 'model') continue;
      const usage = ev.payload?.['usage'];
      if (usage === undefined) continue;
      const rec = usage as Record<string, unknown>;
      const p = Number(rec['promptTokens'] ?? 0);
      const c = Number(rec['completionTokens'] ?? 0);
      const name = ev.payload?.['model'];
      const model = typeof name === 'string' ? name : 'unknown';
      const prev = byModel.get(model) ?? { calls: 0, prompt: 0, completion: 0, total: 0 };
      byModel.set(model, {
        calls: prev.calls + 1,
        prompt: prev.prompt + p,
        completion: prev.completion + c,
        total: prev.total + p + c,
      });
      calls += 1;
      total += p + c;
    }
    return { calls, total, byModel };
  }
}
