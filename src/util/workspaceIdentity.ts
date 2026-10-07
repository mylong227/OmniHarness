import { isAbsolute, resolve, sep } from 'node:path';

/**
 * 工作区（项目）**身份归一**：判断两条 `session_meta.payload.workspace` 是否指同一个项目。
 *
 * ## 为什么必须有它（2026-10-07 用户报「会话没有按所属项目归类 / 切了新项目还显示旧项目的会话」）
 *
 * 会话存档是**全局**的（`~/.omniharness/sessions/*.jsonl`），归属只靠 `session_meta.payload.workspace`
 * 这个**字符串**标记；而 `sessions.list` 的过滤是**字面量相等**比较（`parsed.workspace !== scope`）。
 * 本机实测（1249 条会话）里同一个项目被写成了多种拼写：
 *
 * | 标记 | 条数 |
 * | --- | --- |
 * | `D:\deepseek\omniharness` | 587 |
 * | `D:/deepseek/omniharness` | 155（含大小写/斜杠变体） |
 * | `D:\deepseek\omniharness\.omniharness\model-test-runs\run-…\m1-…` | 各 1（**跑测子目录被当成了项目**） |
 *
 * ⇒ 按字面量归类必然归不准：一个项目裂成好几个"项目"，另一个项目下又混进别家的会话。
 *
 * ## 归一口径（只做**身份等价**，不改用户真实路径语义）
 *
 * 1. 分隔符统一 `\`、盘符统一大写、去尾分隔符、折叠 `\\`；
 * 2. 相对路径按当前进程 cwd 解析成绝对路径（会话标记实际都是绝对路径）；
 * 3. **折叠跑测/探针子目录**：路径里出现 `\.omniharness\model-test-runs\…`（或 `.omniharness\probe…`）
 *    时取该 `.omniharness` 之前的宿主目录 —— 那些是**自动化跑测**在项目内建的工作区，
 *    对用户来说就是宿主项目自己的会话（否则侧栏会冒出十几个"项目"）。
 *
 * 刻意**不做**的事：不解析软链（`realpathSync` 会碰盘、且在归档读取路径上是热路径）、不改大小写
 * 之外的用户可见拼写、不重写任何存档（归一只发生在**比较**与**新写入**两处）。
 */
export class WorkspaceIdentity {
  /** 自动化产物目录名（出现即折叠到其宿主项目）。 */
  private static readonly AUTOMATION_MARKERS: readonly string[] = [
    `${sep}.omniharness${sep}model-test-runs${sep}`,
    `${sep}.omniharness${sep}probe`,
    `${sep}.omniharness${sep}diag-`,
  ];

  /**
   * 归一一条工作区标记。
   * @param raw 原始标记（可能为空、可能是相对路径、可能带 `/`）。
   * @returns 归一后的身份串；空/空白输入返回空串（= 无归属）。
   */
  public static normalize(raw: string | undefined): string {
    const trimmed = (raw ?? '').trim();
    if (trimmed === '') return '';
    let value = WorkspaceIdentity.foldAutomation(trimmed.replace(/\//g, sep));
    if (!isAbsolute(value)) {
      value = resolve(value);
    }
    // 折叠重复分隔符 + 去尾分隔符（根目录 `D:\` 除外）。用 split/filter 而不是正则：
    // Windows 分隔符是 `\`，塞进 `new RegExp` 会变成转义符（首版就踩了这个坑，判据当场抓红）。
    const parts = value.split(sep).filter((part) => part !== '');
    value = parts.join(sep);
    if (/^[a-zA-Z]:$/.test(value)) value += sep; // 纯盘符（`D:`）补根分隔符，避免与相对路径混淆
    return /^[a-zA-Z]:/.test(value) ? value[0]!.toUpperCase() + value.slice(1) : value;
  }

  /**
   * 两条标记是否指同一个项目（两侧都归一后比较）。
   * @param a 标记 a。
   * @param b 标记 b。
   * @returns 同一项目返回 true；任一侧为空（无归属）返回 false。
   */
  public static same(a: string | undefined, b: string | undefined): boolean {
    const na = WorkspaceIdentity.normalize(a);
    const nb = WorkspaceIdentity.normalize(b);
    if (na === '' || nb === '') return false;
    // 盘符路径（Windows）**大小写不敏感**：`D:\A\B` 与 `D:\a\b` 是同一个目录，判成两个项目会让
    // 归类再次失准。POSIX 路径保持大小写敏感（那边确实是两个不同目录）。
    const windowsLike = /^[a-zA-Z]:/.test(na) && /^[a-zA-Z]:/.test(nb);
    return windowsLike ? na.toLowerCase() === nb.toLowerCase() : na === nb;
  }

  /**
   * 折叠「自动化跑测在项目内建的工作区」到宿主项目。
   * @param value 已把 `/` 换成平台分隔符的路径。
   * @returns 宿主项目路径；不含自动化标记时原样返回。
   */
  private static foldAutomation(value: string): string {
    let cut = -1;
    for (const marker of WorkspaceIdentity.AUTOMATION_MARKERS) {
      const at = value.indexOf(marker);
      if (at >= 0 && (cut < 0 || at < cut)) cut = at;
    }
    return cut < 0 ? value : value.slice(0, cut);
  }
}
