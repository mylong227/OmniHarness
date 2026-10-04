/**
 * 语料目录遍历器（G8-c，2026-10-03 从 `ContextEngine` 抽出）。
 *
 * ## 为什么独立成文件
 *
 * ① **职责内聚**：遍历（忽略清单 + 三道上限 + 符号链接与文件类型过滤）与"检索/建索引"是两件事，
 * 前者可被后台索引、增量更新、诊断命令复用；
 * ② **铁律**：抽离前 `ContextEngine` 已达 890 行（上帝类门禁 500 行上限），
 * 本仓的正当修法是**拆类**而不是抬阈值；
 * ③ 同步与可让出两条路径必须**共用同一份闸门口径**（{@link CorpusWalker.buildWalkState}），
 * 同文件才守得住这一点。
 *
 * ## 两条路径的关系
 *
 * - {@link CorpusWalker.walk}：同步（快、不让出；适合 CLI 一次性命令）；
 * - {@link CorpusWalker.walkAsync}：**可让出**（每若干目录项交回宏任务；适合服务端后台索引）。
 *
 * 两者产物**逐位相同**（判据 `nativeTokenAndYield.test.ts` 用例 ⑥ 对 `src/` 全树做深度相等断言）。
 */

import { lstatSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { EventLoopYield } from '../util/async/eventLoopYield.js';
import { WorkspaceFileWalker } from '../util/workspaceFileWalker.js';

/** 语料遍历的上限（三个上限共同把索引内存钉死，见 {@link CorpusWalker.walk}）。 */
export interface WalkLimits {
  /** 最多纳入多少文件（缺省 {@link CorpusWalker.MAX_FILES}）。 */
  readonly maxFiles?: number | undefined;
  /** 单文件字节上限，超过即**不入符号地图**（缺省 {@link CorpusWalker.MAX_FILE_BYTES}）。 */
  readonly maxFileBytes?: number | undefined;
  /** 语料总字节预算，超过即截断（缺省 {@link CorpusWalker.MAX_TOTAL_BYTES}）。 */
  readonly maxTotalBytes?: number | undefined;
}

/** 遍历结果（如实回报「地图少了一块」的两类原因）。 */
export interface WalkOutcome {
  /** 是否因文件数 / 总字节上限被截断。 */
  readonly truncated: boolean;
  /** 因单文件超过字节上限而未纳入的文件数。 */
  readonly skippedLargeFiles: number;
  /** 纳入文件的字节总数（上限判决与「语料多大」都以此为准）。 */
  readonly totalBytes: number;
}

/** 遍历期状态（递归用；`out` 为累积结果）。 */
interface WalkState {
  /** 结果累积（相对 POSIX 路径）。 */
  readonly out: string[];
  /** 还能纳入多少文件。 */
  remaining: number;
  /** 还能纳入多少字节。 */
  bytesLeft: number;
  /** 单文件字节上限。 */
  maxFileBytes: number;
  /** 是否因文件数 / 总字节上限而截断。 */
  truncated: boolean;
  /** 因单文件过大而被排除的文件数（如实回报，不静默）。 */
  skippedLarge: number;
  /** 已纳入文件的字节总数。 */
  bytesTaken: number;
}

/** 语料目录遍历器（同步 + 可让出两条路径，共用同一份闸门口径）。 */
export class CorpusWalker {
  /** 单次索引最多纳入的文件数（与 {@link WorkspaceFileWalker} 同口径，避免两套遍历器各说各话）。 */
  public static readonly MAX_FILES = WorkspaceFileWalker.DEFAULT_MAX_FILES;

  /**
   * 异步遍历的让出粒度（**跨目录累计**的目录项数，G8-c）：每处理这么多项就交回一次宏任务。
   *
   * 取 256 的依据：`src/`（925 文件）实测同步遍历约 54 ms，按 256 项切 ⇒ 单块约 10–15 ms，
   * 落在"单次不让出 ≤ 100 ms"的预算里且不至于让出过频（每次 `setImmediate` 往返有成本）。
   *
   * **必须跨目录累计**：真实源码树全是小目录，按"每目录"计数则永远到不了阈值 ⇒ 几乎不让出
   * （G8-c 首版就是这个缺陷，实测抓出：925 文件只让出 3 次、最长阻塞与同步持平）。
   */
  public static readonly WALK_ASYNC_CHUNK_ENTRIES = 256;

  /**
   * 单文件字节上限（512 KiB）：超过它的源码文件基本是生成物 / 打包产物 / 数据转储，
   * 对「符号地图」零价值，却会一次性吃掉几十上百 MB 堆——故策略性排除并计数上报。
   */
  public static readonly MAX_FILE_BYTES = 512 * 1024;

  /**
   * 语料总字节预算（32 MiB）。为什么必须有它：索引会把每个文件的**全文**与分词结果留在内存里
   * （`fileText` + BM25 文档），实测内存约为原始文本的 10~20 倍；只限文件数（2 万个 × 512 KiB）
   * 最坏仍可达 10 GB ⇒ 必须同时有总量闸。
   */
  public static readonly MAX_TOTAL_BYTES = 32 * 1024 * 1024;

  /** 全量（非 light）模式的总字节预算（5 MiB；比 light 更保守，因为全量解析驻留更多中间结构）。 */
  public static readonly MAX_TOTAL_BYTES_FULL = 5 * 1024 * 1024;

  /**
   * 同步遍历：忽略清单 + 三道上限 + 跳过符号链接。
   *
   * @param root 遍历起点（绝对路径）。
   * @param absRoot 计算相对路径的基准（通常等于 root）。
   * @param out 结果累积数组（就地追加相对 POSIX 路径）。
   * @param limits 上限覆盖（缺省取本类常量）。
   * @returns 截断标记与「因过大被排除的文件数」（调用方须如实转达，不得静默丢弃）。
   */
  public static walk(
    root: string,
    absRoot: string,
    out: string[],
    limits: WalkLimits = {},
  ): WalkOutcome {
    CorpusWalker.assertWalkRoot(root);
    const state = CorpusWalker.buildWalkState(out, limits);
    CorpusWalker.walkInto(state, root, absRoot);
    return {
      truncated: state.truncated,
      skippedLargeFiles: state.skippedLarge,
      totalBytes: state.bytesTaken,
    };
  }

  /**
   * **可让出**的目录遍历（G8-c）：与 {@link CorpusWalker.walk} **同口径、同产物**，
   * 但每 `chunkEntries` 个目录项交回一次宏任务。
   * @param root 遍历起点（绝对路径）。
   * @param absRoot 计算相对路径的基准（通常等于 root）。
   * @param out 结果累积数组（就地追加相对 POSIX 路径）。
   * @param limits 上限覆盖（缺省取本类常量）。
   * @param chunkEntries 让出粒度（**跨目录累计**的目录项数；缺省 {@link CorpusWalker.WALK_ASYNC_CHUNK_ENTRIES}）。
   * @returns 截断标记与「因过大被排除的文件数」（与 `walk` 同）。
   */
  public static async walkAsync(
    root: string,
    absRoot: string,
    out: string[],
    limits: WalkLimits = {},
    chunkEntries: number = CorpusWalker.WALK_ASYNC_CHUNK_ENTRIES,
  ): Promise<WalkOutcome> {
    CorpusWalker.assertWalkRoot(root);
    const state = CorpusWalker.buildWalkState(out, limits);
    await CorpusWalker.walkIntoAsync(state, root, absRoot, chunkEntries, { n: 0 });
    return {
      truncated: state.truncated,
      skippedLargeFiles: state.skippedLarge,
      totalBytes: state.bytesTaken,
    };
  }

  /**
   * 校验遍历根可读且是目录（`walk` / {@link CorpusWalker.walkAsync} 共用）。
   *
   * 根不可读 / 不是目录 ⇒ **抛错**（而不是回空语料）：调用方（`CorpusIndexCache`）据此 fail-closed
   * 返回 null，`getRepoMapContext` 随之为 null。若在这里吞成「空语料」，坏路径会被伪装成
   * 「索引成功但没东西」——正是本仓反复治理的「静默失败」形态。
   * @param root 遍历起点（绝对路径）。
   * @returns 无返回值（不可读时抛错）。
   */
  private static assertWalkRoot(root: string): void {
    let rootStat: ReturnType<typeof statSync>;
    try {
      rootStat = statSync(root);
    } catch (error) {
      throw new Error(
        `语料根不可读：${root}（${error instanceof Error ? error.message : String(error)}）`,
      );
    }
    if (!rootStat.isDirectory()) {
      throw new Error(`语料根不是目录：${root}`);
    }
  }

  /**
   * 构造遍历状态（`walk` 与 {@link CorpusWalker.walkIntoAsync} **共用同一份**口径，
   * 避免两条路径闸门不一致）。
   * @param out 结果累积数组（就地追加相对 POSIX 路径）。
   * @param limits 上限覆盖（缺省取本类常量）。
   * @returns 遍历状态。
   */
  private static buildWalkState(out: string[], limits: WalkLimits): WalkState {
    return {
      out,
      remaining: limits.maxFiles ?? CorpusWalker.MAX_FILES,
      bytesLeft: limits.maxTotalBytes ?? CorpusWalker.MAX_TOTAL_BYTES,
      maxFileBytes: limits.maxFileBytes ?? CorpusWalker.MAX_FILE_BYTES,
      truncated: false,
      skippedLarge: 0,
      bytesTaken: 0,
    };
  }

  /**
   * 递归遍历实现（忽略清单 + 三道上限 + 跳过符号链接）。
   *
   * @param state 遍历状态（就地更新）。
   * @param dir 当前目录。
   * @param absRoot 相对路径基准。
   * @returns 无返回值。
   */
  private static walkInto(state: WalkState, dir: string, absRoot: string): void {
    if (state.truncated) {
      return;
    }
    let entries: readonly string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const entry of entries) {
      if (state.truncated) {
        return;
      }
      const abs = join(dir, entry);
      let st: ReturnType<typeof lstatSync>;
      try {
        st = lstatSync(abs);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) {
        continue;
      }
      if (st.isDirectory()) {
        if (entry.startsWith('.') || WorkspaceFileWalker.DEFAULT_IGNORED_DIRS.has(entry)) {
          continue;
        }
        CorpusWalker.walkInto(state, abs, absRoot);
        continue;
      }
      if (!st.isFile() || !CorpusWalker.isIndexable(entry)) {
        continue;
      }
      if (st.size > state.maxFileBytes) {
        state.skippedLarge += 1;
        continue;
      }
      if (state.remaining <= 0 || st.size > state.bytesLeft) {
        state.truncated = true;
        return;
      }
      state.out.push(relative(absRoot, abs).split(sep).join('/'));
      state.remaining -= 1;
      state.bytesLeft -= st.size;
      state.bytesTaken += st.size;
    }
  }

  /**
   * **可让出的目录遍历**（G8-c）：与 {@link CorpusWalker.walkInto} **同一套判定**，但每处理
   * `chunkEntries` 个目录项就交回一次宏任务（{@link EventLoopYield.turn}）。
   *
   * ## 为什么需要（G8 的遗留）
   *
   * G8 把"逐文件解析"切成了块，但**目录遍历仍是同步段**：`src/`（925 文件）实测遍历约 54 ms，
   * 期间定时器/HTTP 回调被挡住。这 54 ms 虽短，却让"单次索引不让出超过 100 ms"这个上限**收不回来**——
   * 遍历 + 首块解析会叠加。本方法把那一段也切成可让出档。
   * @param state 遍历状态（就地更新）。
   * @param dir 当前目录。
   * @param absRoot 相对路径基准。
   * @param chunkEntries 每处理多少个（跨目录累计的）目录项让出一次。
   * @param counter 跨目录累计计数器（**必须跨目录**，理由见 {@link CorpusWalker.WALK_ASYNC_CHUNK_ENTRIES}）。
   * @returns 无返回值（异步）。
   */
  private static async walkIntoAsync(
    state: WalkState,
    dir: string,
    absRoot: string,
    chunkEntries: number,
    counter: { n: number },
  ): Promise<void> {
    if (state.truncated) {
      return;
    }
    let entries: readonly string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const entry of entries) {
      if (state.truncated) {
        return;
      }
      counter.n += 1;
      if (counter.n % Math.max(1, chunkEntries) === 0) {
        await EventLoopYield.turn();
      }
      const abs = join(dir, entry);
      let st: ReturnType<typeof lstatSync>;
      try {
        st = lstatSync(abs);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) {
        continue;
      }
      if (st.isDirectory()) {
        if (entry.startsWith('.') || WorkspaceFileWalker.DEFAULT_IGNORED_DIRS.has(entry)) {
          continue;
        }
        await CorpusWalker.walkIntoAsync(state, abs, absRoot, chunkEntries, counter);
        continue;
      }
      if (!st.isFile() || !CorpusWalker.isIndexable(entry)) {
        continue;
      }
      if (st.size > state.maxFileBytes) {
        state.skippedLarge += 1;
        continue;
      }
      if (state.remaining <= 0 || st.size > state.bytesLeft) {
        state.truncated = true;
        return;
      }
      state.out.push(relative(absRoot, abs).split(sep).join('/'));
      state.remaining -= 1;
      state.bytesLeft -= st.size;
      state.bytesTaken += st.size;
    }
  }

  /**
   * 该文件名是否是本遍历器纳入的源码类型。
   * @param name 文件名。
   * @returns `.ts` / `.js` / `.py` 之一时为 true。
   */
  private static isIndexable(name: string): boolean {
    return name.endsWith('.ts') || name.endsWith('.js') || name.endsWith('.py');
  }
}
