/**
 * A2A 1.0 `tasks/list` 游标分页（规范 §3.1.4 / §6.5）。
 *
 * ## 契约
 *
 * - **稳定排序**：按 `status.timestamp` 倒序（最近更新在前），时间相同则按 `id` 倒序兜底——
 *   没有二级键时，同毫秒创建的任务顺序取决于 Map 插入顺序，翻页会重复/漏项。
 * - **游标而非偏移**：`pageToken` 是 base64url(JSON) + HMAC-SHA256，携带上一页最后一条的
 *   `(timestamp, id)` 与当时的过滤条件；下一页取「排序上严格位于游标之后」的任务。
 *   偏移分页在深翻页与并发更新下都会漂移，规范明确要求 cursor-based。
 * - **非法 token fail-closed**：签名不符 / 结构非法 / 已过期 / 过滤条件与签发时不一致，
 *   一律抛 `A2A_ERROR_INVALID`，绝不「当作第一页继续」。
 * - **`nextPageToken` 恒存在**：没有更多结果时为空串（规范要求字段必在）。
 *
 * ## 为什么 token 要带过滤条件
 *
 * 同一游标换一组 `contextId` / `state` 去用，会基于「上一页在另一份结果集里的位置」继续，
 * 得到的页既非第一页也不连续——这类静默错序比直接报错更难排查，故按 fail-closed 拒绝。
 *
 * @maturity L1 — 稳定排序 / 非法与过期 token 拒绝 / 过滤漂移拒绝 判据钉死
 * @maturityEvidence tests/unit/a2aPagination.test.ts
 */
import crypto from 'node:crypto';
import type { A2aTask } from './a2aProtocol.ts';
import { A2A_ERROR_INVALID } from './a2aProtocol.ts';
import { A2aProtocolError } from './a2aProtocolError.ts';

/** 缺省页大小（规范：未指定时最多 50 条）。 */
const DEFAULT_PAGE_SIZE = 50;

/** 页大小上限（规范：1..100）。 */
const MAX_PAGE_SIZE = 100;

/** 游标缺省有效期（24 小时）：过期后要求客户端重列，避免无限期可用的旧游标。 */
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

/** 游标载荷（base64url 编码，HMAC 保护完整性）。 */
interface A2aPageCursor {
  /** 版本（未来结构变更时拒绝旧 token）。 */
  readonly v: 1;
  /** 签发时间（epoch 毫秒；用于 TTL）。 */
  readonly at: number;
  /** 上一页最后一条的状态时间戳。 */
  readonly ts: string;
  /** 上一页最后一条的任务 id。 */
  readonly id: string;
  /** 签发时的 contextId 过滤（未过滤则缺省）。 */
  readonly contextId?: string;
  /** 签发时的 state 过滤（未过滤则缺省）。 */
  readonly state?: string;
}

/** 分页查询参数（均来自 JSON-RPC `tasks/list` 的 params）。 */
export interface A2aTaskPageQuery {
  /** 期望页大小（1..100；缺省 50）。 */
  readonly pageSize?: unknown;
  /** 上一页返回的 `nextPageToken`（空串等同未提供）。 */
  readonly pageToken?: unknown;
  /** 按上下文过滤。 */
  readonly contextId?: string | undefined;
  /** 按状态过滤。 */
  readonly state?: string | undefined;
}

/** 一页任务。 */
export interface A2aTaskPage {
  /** 本页任务（按稳定排序）。 */
  readonly tasks: readonly A2aTask[];
  /** 下一页游标；没有更多结果时为空串。 */
  readonly nextPageToken: string;
  /** 本页实际使用的页大小（规范 `ListTasksResponse.pageSize`）。 */
  readonly pageSize: number;
}

/** 分页器选项。 */
export interface A2aTaskPagerOptions {
  /** HMAC 密钥（缺省读 `OMNI_A2A_PAGE_TOKEN_SECRET`，再缺省为进程内随机串）。 */
  readonly secret?: string | Buffer;
  /** 缺省页大小（1..100）。 */
  readonly defaultPageSize?: number;
  /** 页大小上限（1..100）。 */
  readonly maxPageSize?: number;
  /** 游标有效期（毫秒）。 */
  readonly ttlMs?: number;
  /** 注入时钟（测试用；缺省 `Date.now`）。 */
  readonly now?: () => number;
}

/**
 * 任务列表分页器：稳定排序 + HMAC 游标。
 */
export class A2aTaskPager {
  /** HMAC 密钥。 */
  private readonly secret: Buffer;
  /** 缺省页大小。 */
  private readonly defaultPageSize: number;
  /** 页大小上限。 */
  private readonly maxPageSize: number;
  /** 游标有效期（毫秒）。 */
  private readonly ttlMs: number;
  /** 注入时钟。 */
  private readonly now: () => number;

  /**
   * @param options HMAC 密钥 / 页大小 / TTL / 时钟（全部可注入，便于判据与轮换）。
   */
  public constructor(options: A2aTaskPagerOptions = {}) {
    const fromEnv = (process.env['OMNI_A2A_PAGE_TOKEN_SECRET'] ?? '').trim();
    this.secret = Buffer.from(
      options.secret ?? (fromEnv !== '' ? fromEnv : crypto.randomBytes(32)),
    );
    this.maxPageSize = A2aTaskPager.clampInt(options.maxPageSize, MAX_PAGE_SIZE, 1, MAX_PAGE_SIZE);
    this.defaultPageSize = A2aTaskPager.clampInt(
      options.defaultPageSize,
      DEFAULT_PAGE_SIZE,
      1,
      this.maxPageSize,
    );
    this.ttlMs = Math.max(1, options.ttlMs ?? DEFAULT_TTL_MS);
    this.now = options.now ?? Date.now;
  }

  /**
   * 取一页任务（非法游标/页大小一律抛 `A2A_ERROR_INVALID`，fail-closed）。
   * @param all 全部任务（本类自行稳定排序；不要依赖调用方顺序）。
   * @param query 分页与过滤参数。
   * @returns 本页任务、下一页游标与实际页大小。
   */
  public paginate(all: readonly A2aTask[], query: A2aTaskPageQuery): A2aTaskPage {
    const pageSize = this.pageSizeOf(query.pageSize);
    const filters = { contextId: query.contextId, state: query.state };
    const filtered = [...all]
      .sort(A2aTaskPager.compareDescending)
      .filter((task) => filters.contextId === undefined || task.contextId === filters.contextId)
      .filter((task) => filters.state === undefined || task.status.state === filters.state);
    const cursor = this.cursorOf(query.pageToken, filters);
    const firstAfter =
      cursor === undefined ? 0 : filtered.findIndex((task) => this.isAfter(task, cursor));
    const offset = firstAfter < 0 ? filtered.length : firstAfter;
    const tasks = filtered.slice(offset, offset + pageSize);
    const last = tasks.at(-1);
    const hasMore = last !== undefined && offset + tasks.length < filtered.length;
    return {
      tasks,
      pageSize,
      nextPageToken: hasMore ? this.issueToken(last, filters) : '',
    };
  }

  /**
   * 解析并校验页大小。
   * @param raw 请求里的 `pageSize`。
   * @returns 生效页大小。
   */
  private pageSizeOf(raw: unknown): number {
    if (raw === undefined || raw === null) return this.defaultPageSize;
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > this.maxPageSize) {
      throw new A2aProtocolError(
        `pageSize 必须是 1..${String(this.maxPageSize)} 的整数`,
        A2A_ERROR_INVALID,
      );
    }
    return raw;
  }

  /**
   * 解析并校验游标（空串视为未提供）。
   * @param raw 请求里的 `pageToken`。
   * @param filters 本次查询的过滤条件。
   * @returns 游标；未提供时为 undefined。
   */
  private cursorOf(
    raw: unknown,
    filters: { readonly contextId: string | undefined; readonly state: string | undefined },
  ): A2aPageCursor | undefined {
    if (raw === undefined || raw === null) return undefined;
    if (typeof raw !== 'string') {
      throw new A2aProtocolError('pageToken 必须是字符串', A2A_ERROR_INVALID);
    }
    if (raw === '') return undefined;
    const parts = raw.split('.');
    if (parts.length !== 2) {
      throw new A2aProtocolError('分页 token 非法（结构）', A2A_ERROR_INVALID);
    }
    const payloadPart = parts[0] ?? '';
    const macPart = parts[1] ?? '';
    if (!this.macMatches(payloadPart, macPart)) {
      throw new A2aProtocolError('分页 token 非法（签名不匹配）', A2A_ERROR_INVALID);
    }
    const cursor = A2aTaskPager.parseCursor(payloadPart);
    if (cursor === undefined) {
      throw new A2aProtocolError('分页 token 非法（载荷）', A2A_ERROR_INVALID);
    }
    if (this.now() - cursor.at > this.ttlMs) {
      throw new A2aProtocolError('分页 token 已过期', A2A_ERROR_INVALID);
    }
    if (cursor.contextId !== filters.contextId || cursor.state !== filters.state) {
      throw new A2aProtocolError('分页 token 与当前过滤条件不一致', A2A_ERROR_INVALID);
    }
    return cursor;
  }

  /**
   * 为上一页最后一条签发游标。
   * @param task 上一页最后一条任务。
   * @param filters 本次查询的过滤条件。
   * @returns 不透明游标字符串。
   */
  private issueToken(
    task: A2aTask,
    filters: { readonly contextId: string | undefined; readonly state: string | undefined },
  ): string {
    const cursor: A2aPageCursor = {
      v: 1,
      at: this.now(),
      ts: task.status.timestamp ?? '',
      id: task.id,
      ...(filters.contextId !== undefined ? { contextId: filters.contextId } : {}),
      ...(filters.state !== undefined ? { state: filters.state } : {}),
    };
    const payloadPart = Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
    const macPart = this.macOf(payloadPart);
    return `${payloadPart}.${macPart}`;
  }

  /**
   * 判断任务是否排在游标之后（倒序：时间更早，或同时间 id 更小）。
   * @param task 候选任务。
   * @param cursor 游标。
   * @returns 在游标之后为 true。
   */
  private isAfter(task: A2aTask, cursor: A2aPageCursor): boolean {
    const ts = task.status.timestamp ?? '';
    if (ts !== cursor.ts) return ts < cursor.ts;
    return task.id < cursor.id;
  }

  /**
   * 校验游标 MAC（定长比较，避免时序侧信道）。
   * @param payloadPart 游标载荷原文。
   * @param macPart 收到的 MAC。
   * @returns 匹配为 true。
   */
  private macMatches(payloadPart: string, macPart: string): boolean {
    const expected = Buffer.from(this.macOf(payloadPart), 'utf8');
    const actual = Buffer.from(macPart, 'utf8');
    if (expected.length !== actual.length) return false;
    return crypto.timingSafeEqual(expected, actual);
  }

  /**
   * 计算游标 MAC。
   * @param payloadPart 游标载荷原文。
   * @returns base64url 的 HMAC-SHA256。
   */
  private macOf(payloadPart: string): string {
    return crypto.createHmac('sha256', this.secret).update(payloadPart, 'utf8').digest('base64url');
  }

  /**
   * 解析游标载荷（结构非法返回 undefined）。
   * @param payloadPart base64url(JSON) 载荷。
   * @returns 游标；非法时为 undefined。
   */
  private static parseCursor(payloadPart: string): A2aPageCursor | undefined {
    try {
      const decoded = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8')) as unknown;
      if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
        return undefined;
      }
      const record = decoded as Record<string, unknown>;
      if (record['v'] !== 1) return undefined;
      if (typeof record['at'] !== 'number' || !Number.isFinite(record['at'])) return undefined;
      if (typeof record['ts'] !== 'string') return undefined;
      if (typeof record['id'] !== 'string' || record['id'] === '') return undefined;
      const contextId = record['contextId'];
      const state = record['state'];
      if (contextId !== undefined && typeof contextId !== 'string') return undefined;
      if (state !== undefined && typeof state !== 'string') return undefined;
      return {
        v: 1,
        at: record['at'],
        ts: record['ts'],
        id: record['id'],
        ...(typeof contextId === 'string' ? { contextId } : {}),
        ...(typeof state === 'string' ? { state } : {}),
      };
    } catch {
      return undefined;
    }
  }

  /**
   * 稳定倒序比较：状态时间倒序，同时间按 id 倒序（**码元序**，与游标比较同一口径）。
   * @param a 左任务。
   * @param b 右任务。
   * @returns 排序比较值。
   */
  private static compareDescending(a: A2aTask, b: A2aTask): number {
    const at = a.status.timestamp ?? '';
    const bt = b.status.timestamp ?? '';
    if (at !== bt) return at < bt ? 1 : -1;
    if (a.id === b.id) return 0;
    return a.id < b.id ? 1 : -1;
  }

  /**
   * 取整数选项并夹到合法区间（非法回退默认值，绝不因坏配置放大页）。
   * @param raw 注入值。
   * @param fallback 默认值。
   * @param min 下界。
   * @param max 上界。
   * @returns 夹取后的整数。
   */
  private static clampInt(
    raw: number | undefined,
    fallback: number,
    min: number,
    max: number,
  ): number {
    if (raw === undefined || !Number.isInteger(raw)) return fallback;
    return Math.min(max, Math.max(min, raw));
  }
}
