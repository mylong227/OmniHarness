// 会话**侧车文件**（与 `.jsonl` 同目录的 UI 状态）：自定义标题 / 归档名单 / 用户指定顺序。
//
// ## 为什么单独成类
//
// 三个侧车都是「低频、整体重写、损坏即回落默认」的小 JSON：与事件流的读写语义完全不同（事件流是
// 追加、只读回放）。把它们从 `SessionArchive` 里分出来后，那个类只保留「读事件流 / 聚合用量 / 校验
// 会话文件」这族职责，不再被侧车细节撑成上帝类（编码标准门禁的「上帝类」闸）。
//
// ## 故障口径（fail-open 到默认值，不隐藏也不丢会话）
//
// 侧车缺失 / 非法 JSON / 结构不符一律回落：标题表回落空表、归档名单与顺序回落空数组。
// 也就是说「侧车坏了」的最坏后果是「自定义标题没了、归档状态没了、顺序回到时间倒序」，
// **不会**让任何会话从列表里消失（那是比丢一条元数据严重得多的失败模式）。

import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { FileLock } from '../../util/fileLock.js';
import { log } from '../../util/logger.js';
// 排序模型（显式名次 + 新会话置顶）单独成文件：本文件只管侧车文件的读写。
import { SessionRanking, type OrderDoc } from './sessionRanking.js';

/** 乐观并发「读—改—写」的重试轮数（每轮都重读，故并发写会收敛而不是互相覆盖）。 */
const UPDATE_RETRIES = 8;

/** 自定义标题侧车文件名（`{ sessionId: title }`）。 */
const TITLE_FILE = 'sessions.meta.json';
/** 归档名单侧车文件名（`string[]`）。 */
const ARCHIVED_FILE = 'sessions.archived.json';
/** 用户指定顺序侧车文件名（v2 文档；v1 为 `string[]`，读取时兼容）。 */
const ORDER_FILE = 'sessions.order.json';

/** 会话侧车存储：标题 / 归档 / 顺序。 */
export class SessionSidecars {
  /** 取存档目录（每次调用实时求值：切换工作区后跟随）。 */
  private readonly dirOf: () => string | undefined;

  /**
   * @param dirOf 取当前存档目录的函数（缺省/undefined 时所有读写都退化为空操作）
   */
  public constructor(dirOf: () => string | undefined) {
    this.dirOf = dirOf;
  }

  /**
   * 读取自定义标题表。
   * @returns `sessionId → 标题` 映射；文件缺失/损坏时为空表
   */
  public readTitles(): Record<string, string> {
    const parsed = this.readJson(TITLE_FILE);
    if (parsed === undefined || parsed === null || typeof parsed !== 'object') return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string') out[k] = v;
    }
    return out;
  }

  /**
   * 写入自定义标题表（整体重写；乐观并发下会重读重算，保证并发改名不互相覆盖）。
   * @param map `sessionId → 标题` 映射
   * @returns 无返回值。
   */
  public writeTitles(map: Record<string, string>): void {
    this.updateJson(TITLE_FILE, (_current, rev) => ({ rev: rev + 1, ...map }));
  }

  /**
   * 读取归档名单。
   * @returns 已归档 id 列表；缺失/损坏时为空数组
   */
  public readArchived(): string[] {
    return this.readIdList(ARCHIVED_FILE);
  }

  /**
   * 写入归档名单。
   * @param ids 已归档 id 列表
   * @returns 无返回值。
   */
  public writeArchived(ids: readonly string[]): void {
    this.updateJson(ARCHIVED_FILE, (_current, rev) => ({
      rev: rev + 1,
      ids: [...ids],
    }));
  }

  /**
   * 读取排序文档（兼容 v1 数组 / v2 对象）。
   * @returns 排序文档；缺失/损坏时为空文档
   */
  public readOrderDoc(): OrderDoc {
    return SessionRanking.parse(this.readJson(ORDER_FILE));
  }

  /**
   * 写入排序文档（v2 形状；`rev` 供跨进程乐观并发检测）。
   * @param doc 排序文档
   * @returns 无返回值。
   */
  public writeOrderDoc(doc: OrderDoc): void {
    this.updateJson(ORDER_FILE, (_current, rev) => ({
      v: 2,
      rev: rev + 1,
      at: doc.at,
      rank: doc.rank,
    }));
  }

  /**
   * 侧车文件绝对路径。
   * @param name 文件名
   * @returns 路径；存档目录未知时 undefined
   */
  private pathOf(name: string): string | undefined {
    const dir = this.dirOf();
    if (dir === undefined) return undefined;
    return join(dir, name);
  }

  /**
   * 读一个「id 数组」侧车（兼容 `string[]` 与 `{ rev, ids }` 两种形状；非字符串项丢弃）。
   * @param name 文件名
   * @returns id 列表
   */
  private readIdList(name: string): string[] {
    const parsed = this.readJson(name);
    const raw = Array.isArray(parsed)
      ? parsed
      : parsed !== null && typeof parsed === 'object'
        ? ((parsed as Record<string, unknown>)['ids'] ?? [])
        : [];
    if (!Array.isArray(raw)) return [];
    return raw.filter((x): x is string => typeof x === 'string');
  }

  /**
   * 写一个「id 数组」侧车。
   * @param name 文件名
   * @param ids id 列表
   * @returns 无返回值。
   */
  private writeIdList(name: string, ids: readonly string[]): void {
    this.writeJson(name, [...ids]);
  }

  /**
   * 解析侧车 JSON；缺失 / 不可读 / 非法 JSON 返回 undefined（调用方各自回落默认值）。
   * @param name 文件名
   * @returns 解析结果；失败时 undefined
   */
  private readJson(name: string): unknown {
    const path = this.pathOf(name);
    if (path === undefined || !existsSync(path)) return undefined;
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as unknown;
    } catch {
      return undefined;
    }
  }

  /**
   * 原子写侧车：先写同目录临时文件再 `rename`（同分区 rename 是原子的）。
   *
   * 为什么不是「直接 writeFileSync」：整文件重写期间若进程被杀 / 断电，目标文件会**半截**——
   * 而侧车是「损坏即回落默认」的设计，半截 JSON 会让用户的自定义标题 / 归档 / 顺序**整体丢失**
   * （不是丢一条）。原子替换保证任何时刻读到的都是「旧的完整版」或「新的完整版」。
   *
   * **并发口径（本版边界①②的修法）**：同一进程内的「读—改—写」全是同步代码（Node 单线程、中间无
   * `await`）⇒ 天然不可交错；**跨进程**（两个 serve 指向同一存储目录）用 `rev` 做乐观并发：
   * {@link updateJson} 读到旧 `rev` 才提交，否则重读重算（有界重试）。故并发拖拽不会丢写入。
   * @param name 文件名
   * @param value 待写入的 JSON 值
   * @returns 无返回值。
   */
  private writeJson(name: string, value: unknown): void {
    const path = this.pathOf(name);
    if (path === undefined) return;
    const tmp = `${path}.${process.pid}.tmp`;
    const fd = openSync(tmp, 'w');
    try {
      writeFileSync(fd, JSON.stringify(value, null, 2) + '\n', 'utf8');
      // **fsync 再改名**：`rename` 保证「原子可见」，但**不保证内容已落盘** —— 断电时可能留下一个
      // 「名字是新的、内容是空的/半截」的文件。参考实现（npm/write-file-atomic）同样是
      // 「写临时文件 → fsync → rename」，本仓此前省掉了 fsync 这一步。
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  }

  /**
   * 乐观并发的「读—改—写」：读当前文档（含 `rev`）→ 交给纯函数算新值 → 若 `rev` 未变则提交，
   * 变了就重读重算（最多 {@link UPDATE_RETRIES} 轮）。全同步、进程内不可交错；跨进程靠 `rev` 检测。
   * @param name 文件名
   * @param mutate 纯函数：由「当前文档 + rev」算出新文档
   * @returns 提交成功返回 true；目录未知或重试耗尽返回 false
   */
  private updateJson(name: string, mutate: (current: unknown, rev: number) => unknown): boolean {
    const path = this.pathOf(name);
    if (path === undefined) return false;
    // 第一道防线：跨进程租约锁（有界等待）。拿到锁 ⇒ 「读—改—写」不再有人插进来，写入不会放弃；
    // 写盘前用 guard 做 **fencing 核对**：锁若已被接管则抛错并放弃写入（宁可这次改动不落地，
    // 也不覆盖别人的修改 —— 这是 proper-lockfile 系列里 onCompromised 要处理的失败模式）。
    const lock = new FileLock(path);
    try {
      const ok = lock.withLock((guard) => {
        const next = mutate(this.readJson(name), SessionSidecars.revOf(this.readJson(name)));
        guard(); // fencing：锁若已被接管，这里抛错 ⇒ 放弃写入
        this.writeJson(name, next);
      });
      if (ok) return true;
    } catch (err) {
      // 锁被接管（onCompromised 语义）：**放弃这次写入**并留痕，不覆盖别人的修改、不把异常抛给 RPC。
      log.warn('sidecar.write.compromised', {
        name,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
    // 第二道防线（锁没拿到，例如别的进程崩在临界区里、且租约还没到期）：退回乐观并发重试。
    for (let attempt = 0; attempt < UPDATE_RETRIES; attempt++) {
      const current = this.readJson(name);
      const rev = SessionSidecars.revOf(current);
      const next = mutate(current, rev);
      const onDisk = SessionSidecars.revOf(this.readJson(name));
      if (onDisk !== rev) continue; // 期间被别人改过 ⇒ 重读重算
      this.writeJson(name, next);
      return true;
    }
    return false;
  }

  /**
   * 取文档里的 `rev`（无 / 非法按 0 处理）。
   * @param parsed 侧车 JSON
   * @returns rev 数值
   */
  private static revOf(parsed: unknown): number {
    if (parsed !== null && typeof parsed === 'object') {
      const rev = (parsed as Record<string, unknown>)['rev'];
      if (typeof rev === 'number' && Number.isFinite(rev)) return rev;
    }
    return 0;
  }
}
