import { appendFile, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionEvent } from '../../ports/runtime/event.js';
import type { StoragePort } from '../../ports/memory/storage.js';
import { log } from '../../util/logger.js';
import { SessionArchiveLayout } from '../../util/sessionArchiveLayout.js';

/** JSONL 文件存储适配器：每个会话一个 .jsonl 文件（可观测、可回放）。 */
export class JsonlStorage implements StoragePort {
  /** 存储适配器名称（标识此 JSONL 文件存储实现）。 */
  public readonly name = 'jsonl';
  /** 存储目录位置（每个会话一个 `.jsonl` 文件）。 */
  public readonly location: string;

  /**
   * 本实例**上次成功写入**的字节数与条数（追加通道的 O(1) 前缀校验基准）。
   *
   * 为什么用字节数而不是"读全文数行"：读全文是 O(N)，而本项的全部意义就是消除 O(N) 写放大——
   * 若校验也 O(N)，收益立刻打回原形。字节数比对能同时抓住三类情形：别人写过、被截断、归档挪走。
   */
  private readonly written = new Map<string, { count: number; bytes: number }>();

  public constructor(
    /** 存储根目录（自动创建；每个会话写一个 `<sessionId>.jsonl`）。 */
    private readonly directory: string,
  ) {
    this.location = directory;
  }

  /**
   * 保存会话事件（整文件覆盖写，但**原子**：先写 `<file>.tmp` 再 `rename` 覆盖）。
   *
   * 为什么必须原子（审计 §1.7）：整文件 `writeFile` 覆盖到一半崩溃/断电，会留下**半截文件**——
   * 下一次 `load` 要么解析失败、要么（更糟）读到一个看似完整却缺尾的历史，而调用方无从分辨。
   * `rename` 在同一目录内是原子的：读方要么看到旧的完整文件，要么看到新的完整文件。
   * 代价是一次额外写与 rename，对「每回合数百次」的落盘频率可忽略。
   * @param sessionId 会话标识（决定目标文件名）。
   * @param events 完整事件列表（末尾补换行）。
   * @returns 无返回值。
   */
  public async save(sessionId: string, events: readonly SessionEvent[]): Promise<void> {
    const file = this.fileOf(sessionId);
    await mkdir(this.directory, { recursive: true });
    // 归档冷存储：主目录没有文件但 `archive/` 有 ⇒ 先挪回来，避免把历史劈成两半（新文件只有新事件）。
    SessionArchiveLayout.ensureMain(this.directory, sessionId);
    const lines = events.map((event) => JSON.stringify(event)).join('\n');
    const text = `${lines}\n`;
    const tmp = `${file}.tmp`;
    try {
      await writeFile(tmp, text, 'utf8');
      await rename(tmp, file);
    } catch (err) {
      // 失败时清掉半成品，避免下次 load 读到 .tmp（它不参与读取，但会一直堆积）。
      await unlink(tmp).catch(() => undefined);
      throw err;
    }
    // 记下基准：后续 `append` 以"磁盘字节数是否等于这里记录的值"做 O(1) 前缀校验。
    this.written.set(sessionId, { count: events.length, bytes: Buffer.byteLength(text, 'utf8') });
  }

  /**
   * 加载会话事件。
   *
   * **坏行不再导致「静默空历史」**（审计 §1.7）：原实现把整文件 `JSON.parse` 放在同一个 try 里，
   * 一行非法 JSON 就让 `load` 落到 `catch` 返回 `[]`——调用方无法区分「没有历史」与「历史读不出来」，
   * 表现为会话回放/续跑**悄悄丢光全部上下文**。现改为：
   *  - 文件不存在 ⇒ 空数组（正常的「无历史」）；
   *  - 其它读取错误 ⇒ warn + 空数组（不抛错，保持原契约，但**不再无声**）；
   *  - 个别坏行 ⇒ **跳过该行并 warn**（带行号），其余事件照常返回（能救多少救多少）；
   *  - 有内容但**全部**行都解析失败 ⇒ 额外 warn 一条 `all_lines_corrupt`（这是文件级损坏的信号）。
   * @param sessionId 会话标识。
   * @returns 成功解析出的事件列表（按文件行序）；文件缺失/不可读时为空数组（不抛错）。
   */
  public async load(sessionId: string): Promise<readonly SessionEvent[]> {
    // 归档冷存储：主目录找不到时读 `archive/` 里的副本（否则「打开归档会话」会得到空历史，
    // 看起来像历史丢了 —— 比报错更糟）。找不到时退回主目录路径，交由下面的 ENOENT 分支处理。
    const file = SessionArchiveLayout.find(this.directory, sessionId) ?? this.fileOf(sessionId);
    let content: string;
    try {
      content = await readFile(file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.warn('storage.jsonl.unreadable', { sessionId, file, error: String(err) });
      }
      return [];
    }
    return this.parseLines(content, sessionId, file);
  }

  /**
   * **追加**会话事件（G7：真追加，不再整文件重写）。
   *
   * ## 前缀校验（fail-closed）
   *
   * 本适配器只接受"**由本实例上一次成功写过**"的文件，校验方式是比对**字节数**（O(1)，无需读全文）：
   *  - 从未在本实例写过（冷启动 / 换进程 / 归档挪动）⇒ 抛错，由调用方回退全量 `save`；
   *  - 磁盘字节数与上次写后记录的不一致（别人改过 / 被截断 / 归档挪走）⇒ 抛错。
   *
   * 「宁抛勿猜」是刻意的：一次错位追加会让历史永久错乱，而存档表面看起来仍然正常
   * （`load` 会照常返回一堆事件）——这正是本仓反复治理的"静默错误"形态。
   *
   * ## 原子性口径
   *
   * 追加**不是**原子的（一次 `appendFile` 崩溃可能留下半行）。可接受的理由有二：
   *  1. 撕裂只会落在**最后一行**，而 `load` 对坏行是"跳过并告警"，前面的事件一条不少；
   *  2. 全量路径的原子性（tmp+rename）代价是 O(N) 重写，正是本项要消除的写放大。
   * @param sessionId 会话标识（决定目标文件名）。
   * @param events 完整事件列表（只追加 `fromCount` 之后的部分）。
   * @param fromCount 调用方声明的"后端已有条数"。
   * @returns 无返回值；校验失败时抛错。
   */
  public async append(
    sessionId: string,
    events: readonly SessionEvent[],
    fromCount: number,
  ): Promise<void> {
    const file = this.fileOf(sessionId);
    const known = this.written.get(sessionId);
    if (known === undefined || known.count !== fromCount) {
      throw new Error(
        `jsonl 追加前置校验失败：本实例未记录该会话的上次写入（known=${String(known?.count)}，声明=${String(fromCount)}）`,
      );
    }
    const size = await this.sizeOf(file);
    if (size !== known.bytes) {
      throw new Error(
        `jsonl 追加前置校验失败：文件字节数已被外部改变（磁盘=${String(size)}，记录=${String(known.bytes)}）`,
      );
    }
    const tail = events.slice(fromCount);
    if (tail.length === 0) {
      return;
    }
    const text = `${tail.map((event) => JSON.stringify(event)).join('\n')}\n`;
    await appendFile(file, text, 'utf8');
    this.written.set(sessionId, {
      count: events.length,
      bytes: size + Buffer.byteLength(text, 'utf8'),
    });
  }

  /**
   * 取文件字节数（不存在时为 0）。
   * @param file 目标文件路径。
   * @returns 字节数。
   */
  private async sizeOf(file: string): Promise<number> {
    try {
      return (await stat(file)).size;
    } catch {
      return 0;
    }
  }

  /** 会话文件路径。
   * @param sessionId 会话标识。
   * @returns 该会话对应的 .jsonl 文件绝对/相对路径。
   */
  private fileOf(sessionId: string): string {
    return join(this.directory, `${sessionId}.jsonl`);
  }

  /**
   * 解析 JSONL 文本为事件列表：逐行解析，**坏行跳过并告警**（不放弃整份历史）。
   * @param content JSONL 全文（每行一个 JSON 对象）。
   * @param sessionId 会话标识（仅用于告警归因）。
   * @param file 文件路径（仅用于告警归因）。
   * @returns 逐行解析出的事件数组（跳过空行与坏行）。
   */
  private parseLines(content: string, sessionId: string, file: string): readonly SessionEvent[] {
    const events: SessionEvent[] = [];
    let bad = 0;
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? '';
      if (line.trim() === '') {
        continue;
      }
      try {
        events.push(JSON.parse(line) as SessionEvent);
      } catch (err) {
        bad += 1;
        log.warn('storage.jsonl.bad_line', {
          sessionId,
          file,
          line: i + 1,
          error: String(err),
        });
      }
    }
    if (bad > 0 && events.length === 0) {
      // 有内容却一行都解析不出来 ⇒ 文件级损坏（截断/换行被破坏/编码错），单独记一条便于告警聚合。
      log.warn('storage.jsonl.all_lines_corrupt', { sessionId, file, lines: bad });
    }
    return events;
  }
}
