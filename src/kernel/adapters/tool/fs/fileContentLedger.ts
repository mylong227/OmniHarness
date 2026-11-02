/**
 * 文件内容账本（S1 陈旧读 / 冲突保护；2026-10-25 升级为**按会话基线**）。
 *
 * 解决的问题：原实现里 `.bak` 只是**事后备份**，不是**冲突检测**——模型读到某文件后，
 * 若期间被别的进程（另一个会话、编辑器、`shell` 里的一次重定向）改过，接着的覆盖式写入
 * 会**静默抹掉**那些改动。
 *
 * ## 2026-10-25 的关键修正：全局一份指纹不足以识别「跨会话」
 *
 * 旧账本只有「该路径最新内容」一份记录。于是：
 *
 * 1. 会话 A 读 `x`（账本=x）；
 * 2. 会话 B 写 `y`（账本=y）；
 * 3. 会话 A 再写：`changedSince` 拿账本 y 与磁盘 y 比 ⇒ **相等，放行** ⇒ A 的陈旧内容覆盖 B。
 *
 * 这正是「多会话同时改同一文件」的核心漏洞。现在账本按 **owner（会话 id）** 保存观察到的版本：
 * 读者只记录**自己**看到的基线；写者同时推进全局基线与自己的基线。`changedSince(path, current, owner)`
 * 优先比该 owner 的基线——A 的基线仍是 x，磁盘已是 y ⇒ 冲突。没有 owner 的旧调用退回全局口径
 * （兼容既有工具与测试）。
 *
 * 语义（刻意做成「只在不一致时拦」而不是「一律要求先读」）：
 * - `observe`（读）只记录**该会话**看到的版本，不推进全局版本（否则一次慢读会把别人刚写的
 *   新版本“降级”回旧版本）；
 * - `remember`（写）推进全局版本与写者版本；
 * - 落盘前比对磁盘现状：有基线且不一致 ⇒ 改动来自该基线之后 ⇒ fail-closed 拒绝并提示先重读；
 * - 没有基线（从未读过的新文件）⇒ 不拦（否则新建文件都会被拒）。
 *
 * 仅内存、进程内有效；容量有界（默认 8192 个路径，超出按插入序淘汰最旧）。被淘汰的路径等价于
 * 「从未读过」——只降低保护水位，不会误拦。
 *
 * 2026-10-26：除哈希外，还按 `(路径, 会话)` 保存**基线全文**（`SessionBaselineStore`，有界），
 * 让 `write_file`/`edit`/`apply_patch` 能做真正的行级 diff3；文本超限/被淘汰时退回哈希口径。
 */
import { createHash } from 'node:crypto';
import { SessionBaselineStore } from './sessionBaselineStore.ts';

/** 最多追踪多少个路径（有界内存；超出淘汰最旧插入项）。 */
const MAX_TRACKED_PATHS = 8_192;

/** 单路径最多保留多少个会话基线（防止长跑进程里会话 id 无限堆积）。 */
const MAX_OWNERS_PER_PATH = 128;

/** 单路径账本记录。 */
interface PathRecord {
  /** 全局最新已知版本（写入推进；读取不推进）。 */
  known: string;
  /** 会话 id → 该会话最近一次观察/写入的版本。 */
  readonly versions: Map<string, string>;
}

/**
 * 文件内容账本（进程内，内存态；可被同一进程的所有会话共享）。
 */
export class FileContentLedger {
  /** 路径 → 记录（插入序用于有界淘汰）。 */
  private readonly records = new Map<string, PathRecord>();
  /** 按会话保存的基线全文（三方合并的共同祖先；有界 LRU）。 */
  private readonly baselines = new SessionBaselineStore();

  /**
   * 记录**写入**后的最新内容（推进全局版本与写者版本）。
   *
   * @param absolutePath 文件绝对路径。
   * @param content 刚写入的内容。
   * @param owner 会话 id（可选；缺省只推进全局版本，兼容旧调用）。
   * @returns 无返回值。
   */
  public remember(absolutePath: string, content: string, owner?: string): void {
    const record = this.recordOf(absolutePath);
    const hash = FileContentLedger.hashOf(content);
    record.known = hash;
    if (owner === undefined || owner === '') {
      // 无 owner 的 remember 是「显式重置该路径」：清掉各会话旧基线，否则旧 owner 会继续
      // 拿着更早的版本把下一次写入判成冲突（既有测试/维护入口正是这个语义）。
      record.versions.clear();
      this.baselines.deletePath(absolutePath);
      return;
    }
    FileContentLedger.putVersion(record, owner, hash);
    // 同时保存全文，供后续三方合并使用；超限时 Store 会丢弃，只影响「自动合并」能力。
    this.baselines.set(absolutePath, owner, content);
  }

  /**
   * 记录**读取**到的内容（只记录该会话的基线，不推进全局版本）。
   *
   * 为什么读不推进全局：A 读一个大文件时 B 已写入新版本；A 的读完得晚，若把全局版本写回旧值，
   * 后续没有基线的写入就会误以为旧值是新值。全局版本只由写者推进，才单调。
   *
   * @param absolutePath 文件绝对路径。
   * @param content 读取到的内容。
   * @param owner 会话 id；缺省等价于 `remember`（旧调用语义）。
   * @returns 无返回值。
   */
  public observe(absolutePath: string, content: string, owner?: string): void {
    if (owner === undefined || owner === '') {
      this.remember(absolutePath, content);
      return;
    }
    const record = this.recordOf(absolutePath);
    FileContentLedger.putVersion(record, owner, FileContentLedger.hashOf(content));
    this.baselines.set(absolutePath, owner, content);
  }

  /**
   * 判断磁盘现状是否**背离**该会话（或全局）已知内容。
   *
   * @param absolutePath 文件绝对路径。
   * @param current 磁盘上的当前内容。
   * @param owner 会话 id（可选；有该会话基线时优先用它）。
   * @returns 无基线时 false（不拦）；有基线且指纹不同时 true。
   */
  public changedSince(absolutePath: string, current: string, owner?: string): boolean {
    const expected = this.baselineOf(absolutePath, owner);
    if (expected === undefined) return false;
    return expected !== FileContentLedger.hashOf(current);
  }

  /**
   * 取该会话（或全局）的基线指纹。
   *
   * @param absolutePath 文件绝对路径。
   * @param owner 会话 id（可选）。
   * @returns 基线 sha256；无基线时 undefined。
   */
  public baselineOf(absolutePath: string, owner?: string): string | undefined {
    const record = this.records.get(absolutePath);
    if (record === undefined) return undefined;
    if (owner !== undefined && owner !== '') {
      const owned = record.versions.get(owner);
      if (owned !== undefined) return owned;
    }
    return record.known === '' ? undefined : record.known;
  }

  /**
   * 丢弃某文件的全部记录（删除文件 / 需要强制重置时用）。
   *
   * @param absolutePath 文件绝对路径。
   * @returns 无返回值。
   */
  public forget(absolutePath: string): void {
    this.records.delete(absolutePath);
    this.baselines.deletePath(absolutePath);
  }

  /**
   * 取该会话最近一次读/写到的**全文**（三方合并的共同祖先）。
   *
   * 只在该会话确有基线且文本未被容量淘汰时返回；调用方必须自己核对它的哈希与
   * `baselineOf` 一致（避免用一份过期文本做合并）。
   * @param absolutePath 文件绝对路径。
   * @param owner 会话 id。
   * @returns 基线全文；没有/已淘汰时 undefined。
   */
  public baselineTextOf(absolutePath: string, owner: string): string | undefined {
    return this.baselines.get(absolutePath, owner);
  }

  /**
   * 当前保存的基线文本总字节数（诊断/测试）。
   * @returns 字节数。
   */
  public baselineBytes(): number {
    return this.baselines.sizeBytes();
  }

  /**
   * 丢弃「命令文本里可能被改到的」文件的记录。
   *
   * 存在理由（2026-09-26 审计 A6）：账本原先只在 `read_file` 与三个 fs 写工具之间闭环，
   * **完全不知道 `shell` 的改动** —— 于是 `read_file(a)` → `shell: echo x > a` →
   * `write_file(a)` 这条链上，第三步会拿着「陈旧但账本认为新鲜」的指纹把 shell 的改动静默抹掉。
   *
   * 实现刻意**不做 shell 语法解析**（解析错判会引入新的绕过面）：只做「保守失效」——
   * 命令文本里出现了某条已记账路径的**绝对形式或其工作区相对形式**，就把该条丢掉；丢记录
   * 只会让后续写入**不再被拦**（等价于改造前行为），不会误拦。
   *
   * @param command 即将执行的 shell 命令文本。
   * @param workspaceRoot 工作区根（用于把相对形式与绝对记账键对上）。
   * @returns 被失效的条目数。
   */
  public forgetMentionedIn(command: string, workspaceRoot: string): number {
    if (command === '' || this.records.size === 0) {
      return 0;
    }
    let forgotten = 0;
    const root = workspaceRoot.replace(/[\\/]+$/, '');
    for (const absolute of [...this.records.keys()]) {
      const relative = absolute.startsWith(root) ? absolute.slice(root.length + 1) : undefined;
      // 分隔符两种写法都要试：Windows 上记账键是 `a\b.ts`，而模型写的命令常见 `a/b.ts`。
      const forward = relative?.split('\\').join('/');
      const hit =
        command.includes(absolute) ||
        (relative !== undefined && relative !== '' && command.includes(relative)) ||
        (forward !== undefined && forward !== '' && command.includes(forward));
      if (hit) {
        this.records.delete(absolute);
        this.baselines.deletePath(absolute);
        forgotten += 1;
      }
    }
    return forgotten;
  }

  /**
   * 当前被追踪的文件数（供测试与诊断）。
   *
   * @returns 已记录指纹的文件数量。
   */
  public size(): number {
    return this.records.size;
  }

  /**
   * 某文件被多少个会话记录过基线（诊断：判断跨会话竞争是否真实存在）。
   *
   * @param absolutePath 文件绝对路径。
   * @returns 会话数；无记录时为 0。
   */
  public ownerCountOf(absolutePath: string): number {
    return this.records.get(absolutePath)?.versions.size ?? 0;
  }

  /**
   * 生成对模型可行动的冲突文案（明确告诉它下一步做什么）。
   *
   * @param relative 目标文件相对路径。
   * @param detail 可选的版本差异说明（已由调用方组织好）。
   * @returns 冲突说明文本。
   */
  public static conflictMessage(relative: string, detail?: string): string {
    const tail = detail === undefined || detail === '' ? '' : `（${detail}）`;
    return (
      `${relative} 自上次读取后已被本工具链之外改动${tail}（例如 shell 重定向、编辑器或其他会话）。` +
      '为避免覆盖这些改动，本次写入已被拒绝。请先 read_file 重新读取该文件、确认现状后再次写入。'
    );
  }

  /**
   * 计算内容指纹（sha256；冲突文案里取前 12 位展示）。
   *
   * @param content 文件内容。
   * @returns sha256 十六进制串。
   */
  public static hashOf(content: string): string {
    return createHash('sha256').update(content, 'utf8').digest('hex');
  }

  /**
   * 把指纹压成可读短串（错误文案用）。
   *
   * @param hash 完整指纹。
   * @returns 前 12 位；空串返回 `(none)`。
   */
  public static shortHash(hash: string | undefined): string {
    return hash === undefined || hash === '' ? '(none)' : hash.slice(0, 12);
  }

  /**
   * 取或建记录（有界：超过上限淘汰最旧插入项）。
   *
   * @param absolutePath 文件绝对路径。
   * @returns 记录。
   */
  private recordOf(absolutePath: string): PathRecord {
    const existing = this.records.get(absolutePath);
    if (existing !== undefined) return existing;
    while (this.records.size >= MAX_TRACKED_PATHS) {
      const oldest = this.records.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.records.delete(oldest);
    }
    const record: PathRecord = { known: '', versions: new Map() };
    this.records.set(absolutePath, record);
    return record;
  }

  /**
   * 写入一条会话版本（超出会话上限时淘汰最旧会话）。
   *
   * @param record 路径记录。
   * @param owner 会话 id。
   * @param hash 内容指纹。
   * @returns 无返回值。
   */
  private static putVersion(record: PathRecord, owner: string, hash: string): void {
    record.versions.set(owner, hash);
    if (record.versions.size <= MAX_OWNERS_PER_PATH) return;
    for (const candidate of record.versions.keys()) {
      if (candidate === owner) continue;
      record.versions.delete(candidate);
      return;
    }
  }
}
