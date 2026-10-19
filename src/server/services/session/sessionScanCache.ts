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
 * ## 缓存边界
 *
 * 有界：超过 4096 条整体清空重建（极端多会话场景不会无限吃内存）。
 * 只缓存**解析结果**，不缓存文件内容；返回值是深拷贝过的普通对象/Map，调用方改不到缓存。
 */

import { readFile, stat } from 'node:fs/promises';
import { SessionFileScanner } from './sessionFileScanner.ts';

/** 会话摘要（`list` 需要的字段）。 */
export interface SessionSummary {
  /** 归属工作区（`session_meta.payload.workspace`；老存档可能没有）。 */
  readonly workspace?: string | undefined;
  /** 创建会话时记录的模型名（老存档没有；有 `model` 事件时回填）。 */
  readonly model?: string | undefined;
  /**
   * 是否为 mock/演示会话。
   *
   * 判据（按可靠性排序）：`session_meta.model === 'mock'` → 工具调用 id 以 `mock_call_` 开头
   * → assistant 文案含「模拟模型适配器输出」。**不能**用「没有 model 事件」判定：用户只发了
   * 一句话就取消的会话同样没有 model 事件，把它当 mock 会误伤真实会话。
   */
  readonly mock: boolean;
  /** 首条用户消息前 80 字（无自定义标题时作标签）。 */
  readonly label: string;
  /** 用户回合数。 */
  readonly turns: number;
  /** 最后一条事件的时间戳（ISO 字符串；没有则为空串）。 */
  readonly updatedAt: string;
  /** 有效时长（ms）：首末事件间隔 − 空闲间隔（>5 分钟且后接 user 事件）。 */
  readonly activeMs: number;
  /** 被剔除的空闲间隔个数（用户离开后再回来）。 */
  readonly idleGaps: number;
}

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
   * 命中缓存则直接返回；否则调用 `load()` 解析并写回缓存。
   * @param file 文件路径
   * @param load 解析函数（仅在未命中时调用）
   * @returns 解析结果与文件戳；文件不可读或解析失败时为 `undefined`
   */
  public async getOrLoad(
    file: string,
    load: () => Promise<V | undefined>,
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
      const task = load();
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
    return this.listCache.getOrLoad(file, () => SessionScanCache.parseSummary(file));
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
   * 解析摘要：工作区 / 模型 / mock 标记 / 首条 user / 回合数 / 最后时间戳 / 有效时长。
   *
   * 仍然一次整读文件（列表缓存按 `(mtime,size)` 命中，稳态只 stat），但**同一次遍历**把
   * mock 与有效时长一起算出来，避免为了新字段再扫一遍。
   *
   * @param file 存档绝对路径
   * @returns 摘要；不可读时 `undefined`
   */
  private static async parseSummary(file: string): Promise<SessionSummary | undefined> {
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch {
      return undefined;
    }
    let workspace: string | undefined;
    let model: string | undefined;
    let label = '';
    let turns = 0;
    let updatedAt = '';
    let mock = false;
    let firstTs: number | null = null;
    let prevTs: number | null = null;
    let idleMs = 0;
    let idleGaps = 0;
    for (const line of text.split('\n')) {
      const ev = SessionFileScanner.parseLine(line);
      if (ev === undefined) continue;
      const payload = ev.payload;
      if (ev.type === 'session_meta') {
        if (typeof payload?.['workspace'] === 'string') {
          workspace = payload['workspace'] as string;
        }
        if (typeof payload?.['model'] === 'string') {
          model = payload['model'] as string;
          if (model === 'mock') mock = true;
        }
      } else if (ev.type === 'user') {
        if (label === '') {
          const content = payload?.['content'];
          if (typeof content === 'string') label = content.slice(0, 80);
        }
        turns += 1;
      } else if (ev.type === 'tool_call') {
        const callId = payload?.['callId'];
        if (typeof callId === 'string' && callId.startsWith('mock_call_')) mock = true;
      } else if (ev.type === 'assistant') {
        const content = payload?.['content'];
        if (typeof content === 'string' && content.includes('模拟模型适配器输出')) mock = true;
      } else if (ev.type === 'model' && model === undefined) {
        const name = payload?.['model'];
        if (typeof name === 'string') {
          model = name;
          if (name === 'mock') mock = true;
        }
      }
      if (typeof ev.timestamp === 'string') {
        updatedAt = ev.timestamp;
        const ts = Date.parse(ev.timestamp);
        if (Number.isFinite(ts)) {
          if (firstTs === null) firstTs = ts;
          if (prevTs !== null) {
            const gap = ts - prevTs;
            // 空闲 = 长间隔且间隔之后是用户消息（人离开后再回来）；模型生成延迟不算空闲。
            if (gap > SessionScanCache.IDLE_GAP_MS && ev.type === 'user') {
              idleMs += gap;
              idleGaps += 1;
            }
          }
          prevTs = ts;
        }
      }
    }
    const spanMs = firstTs === null || prevTs === null ? 0 : Math.max(0, prevTs - firstTs);
    return {
      workspace,
      ...(model !== undefined ? { model } : {}),
      mock,
      label,
      turns,
      updatedAt,
      activeMs: Math.max(0, spanMs - idleMs),
      idleGaps,
    };
  }

  /** 判定「用户离开」的最小间隔：5 分钟（与 tools/sessionTelemetry.mjs 同口径）。 */
  private static readonly IDLE_GAP_MS = 5 * 60 * 1000;

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
