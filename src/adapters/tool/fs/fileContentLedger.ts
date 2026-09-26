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
    if (command === '' || this.known.size === 0) {
      return 0;
    }
    let forgotten = 0;
    const root = workspaceRoot.replace(/[\\/]+$/, '');
    for (const absolute of [...this.known.keys()]) {
      const relative = absolute.startsWith(root) ? absolute.slice(root.length + 1) : undefined;
      // 分隔符两种写法都要试：Windows 上记账键是 `a\b.ts`，而模型写的命令常见 `a/b.ts`。
      const forward = relative?.split('\\').join('/');
      const hit =
        command.includes(absolute) ||
        (relative !== undefined && relative !== '' && command.includes(relative)) ||
        (forward !== undefined && forward !== '' && command.includes(forward));
      if (hit) {
        this.known.delete(absolute);
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
