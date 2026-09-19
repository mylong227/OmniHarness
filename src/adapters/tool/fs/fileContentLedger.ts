/**
 * 文件内容账本（S1-陈旧读 / 冲突保护）。
 *
 * 解决的问题：原实现里 `.bak` 只是**事后备份**，不是**冲突检测**——模型读到某文件后，
 * 若期间被别的进程（另一个会话、编辑器、`shell` 里的一次重定向）改过，接着的覆盖式写入
 * 会**静默抹掉**那些改动。
 *
 * 语义（刻意做成「只在不一致时拦」而不是「一律要求先读」）：
 * - `read_file` 成功 → {@link remember} 记录该文件的**内容指纹**；
 * - 任何写类工具（write_file / edit / apply_patch）落盘成功后同样 {@link remember}
 *   新内容 —— 于是**本进程自己的连续改写不会误报**，账本始终是「我们已知的最新内容」；
 * - 落盘前用 {@link changedSince} 比对磁盘现状：账本**有**该文件记录且指纹不同
 *   ⇒ 说明改动来自本工具链之外 ⇒ fail-closed 拒绝并提示先重读；
 * - 账本**没有**记录（从未读过的新文件）⇒ 返回 false，不拦（否则新建文件都会被拒）。
 *
 * 仅内存、进程内有效：进程重启后账本为空，等价于关闭该保护（刻意——持久化会引入
 * 与 worktree / 多副本不一致的新失败面）。
 */
import { createHash } from 'node:crypto';

/**
 * 文件内容账本（进程内，内存态）。
 */
export class FileContentLedger {
  /** 已知内容指纹：绝对路径 → sha1。 */
  private readonly known = new Map<string, string>();

  /**
   * 记录某文件「我们已知的最新内容」。
   *
   * @param absolutePath 文件绝对路径。
   * @param content 已知内容（读取到的或刚写入的）。
   * @returns 无返回值。
   */
  public remember(absolutePath: string, content: string): void {
    this.known.set(absolutePath, FileContentLedger.fingerprint(content));
  }

  /**
   * 判断磁盘现状是否**背离**账本已知内容（即被本工具链之外改动过）。
   *
   * @param absolutePath 文件绝对路径。
   * @param current 磁盘上的当前内容。
   * @returns 账本无记录时返回 false（不拦）；有记录且指纹不同时返回 true。
   */
  public changedSince(absolutePath: string, current: string): boolean {
    const previous = this.known.get(absolutePath);
    if (previous === undefined) {
      return false;
    }
    return previous !== FileContentLedger.fingerprint(current);
  }

  /**
   * 丢弃某文件的记录（删除文件 / 需要强制重置时用）。
   *
   * @param absolutePath 文件绝对路径。
   * @returns 无返回值。
   */
  public forget(absolutePath: string): void {
    this.known.delete(absolutePath);
  }

  /**
   * 当前被追踪的文件数（供测试与诊断）。
   *
   * @returns 已记录指纹的文件数量。
   */
  public size(): number {
    return this.known.size;
  }

  /**
   * 生成对模型可行动的冲突文案（明确告诉它下一步做什么）。
   *
   * @param relative 目标文件相对路径。
   * @returns 冲突说明文本。
   */
  public static conflictMessage(relative: string): string {
    return (
      `${relative} 自上次读取后已被本工具链之外改动（例如 shell 重定向、编辑器或其他会话）。` +
      '为避免覆盖这些改动，本次写入已被拒绝。请先 read_file 重新读取该文件、确认现状后再次写入。'
    );
  }

  /**
   * 计算内容指纹。
   *
   * @param content 文件内容。
   * @returns sha1 十六进制串。
   */
  private static fingerprint(content: string): string {
    return createHash('sha1').update(content, 'utf8').digest('hex');
  }
}
