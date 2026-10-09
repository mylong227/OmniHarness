/**
 * CLI **未知旗标的拼写建议**（did-you-mean，2026-10-08 易用性轮）。
 *
 * ## 为什么要有它（这是"低学习成本"的直接缺口）
 *
 * `ArgParser.parseArgs` 对不认识的 `-` 开头 token 是 fail-closed 的（正确），但报错只说了
 * 「本 CLI 不认识它；用 --help 查看全部旗标」——而 `--help` 是一份 **100+ 行**的全量清单。
 * 真实使用里最高频的失败不是"用了不存在的功能"，而是**手滑打错一个字母**
 * （`--modle` / `--worksapce` / `--approvl`）。此时用户要做的是"在几百行里找那个正确的名字"，
 * 或者干脆放弃。一条「你是不是想用 `--model`？」把这一步从分钟级降到零。
 *
 * ## 判据（宁缺勿滥）
 *
 * 建议**只在把握大时给出**：错误的名字 ⇒ 静默不给建议（噪声建议比没有建议更伤信任，
 * 且会让人怀疑解析器本身）。因此：
 *   · 只对**长旗标**（`--x`）做候选——短旗标（`-h`/`-V`/`-p`）互相只差一个字母，
 *     任何距离口径都会给出并列候选，故整类不猜；
 *   · 归一化时**剥掉全部前导 `-`**：这样 `-model`（少打一个横线）能精确命中 `--model`；
 *   · **首字符必须一致**：手滑极少改掉首字母。这条把 `--work ⇒ --fork` 这类"距离为 1
 *     但毫不相干"的猜测整类挡掉（实测：只有距离阈值时真会给出这个错误建议）；
 *   · 距离用 **OSA（最优字符串对齐，含相邻换位）**：`modle → model` 是**换位**，
 *     普通 Levenshtein 距离是 2（会被阈值挡掉），OSA 是 1——而换位正是最典型的手滑形态；
 *   · 阈值随名字长度收紧：长度 ≤4 只容 1 个编辑，更长容 2 个；
 *   · 出现**并列最优**时不给建议（让用户自己看帮助，好过猜错）；
 *   · 前缀缩写（`--work` ⇒ `--workspace`）只在**唯一匹配**时给出。
 *
 * 判据见 `tests/unit/flagSuggestion.test.ts`（含"不认识的名字不得瞎猜"这条负对照）。
 *
 * **本文件是叶子模块**：不 import 任何 `src/cli/**` 兄弟（尤其 `cliFlagTable`）——已知旗标清单由
 * 调用方注入。理由不是洁癖：`cli/{argParser,cliEnums,cliFlagTable,cliHelp}` 本来就是架构门禁里
 * 登记的**白名单环①**，本模块一旦反向 import `cliFlagTable`，就会把那个环从 4 成员**撑到 5 成员**，
 * 架构门禁当场报「新增环」并中止提交（2026-10-08 实测踩到）。把清单做成参数后，本模块零出边。
 */
export class FlagSuggestion {
  /** 名字长度 ≤ 本值时只容 1 个编辑距离，超过则容 2（越长越不容易撞车）。 */
  private static readonly SHORT_NAME_MAX = 4;

  /** 短于本长度的 token 一律不猜（3 个字符的候选空间太密，猜错概率高于猜中）。 */
  private static readonly MIN_BARE_LENGTH = 3;

  /**
   * 拼装「未知旗标」的**面向用户**报错文案（`ArgParser.parseArgs` 的唯一调用点）。
   *
   * 文案形状是**契约**：`未知旗标 <token>` 必须保持**连在一起**——`knownFlags.test.ts` 的
   * ④/⑥ 与 `probesInRepo.test.ts` 的 ⑧ 都按这个子串断言"报错指名的正是那个真未知旗标"。
   * 建议句只在**有把握时**追加，故"没有建议"与历史文案**逐字相同**（零行为回归）。
   * @param token 用户敲下的原始 token。
   * @param known 本 CLI 认识的**全部**旗标名（由调用方从 `CliFlagTable.knownFlagNames()` 取，见类注释）
   * @returns 带可选拼写建议的报错文案。
   */
  public static unknownFlagMessage(token: string, known: Iterable<string>): string {
    const guess = FlagSuggestion.suggest(token, known);
    const lead = guess === null ? '' : `你是不是想用 ${guess}？`;
    return (
      `未知旗标 ${token}（${lead}本 CLI 不认识它；用 --help 查看全部旗标。` +
      `若 prompt 本身以 - 开头，请用 --prompt 传递或写在 \`--\` 之后）`
    );
  }

  /**
   * 为未知旗标挑一个"最像"的已知旗标。
   * @param token 用户敲下的原始 token（含前导 `-`，如 `--modle` / `-model`）。
   * @param known 本 CLI 认识的**全部**旗标名（含 `--` 前缀；短旗标会被本函数忽略）。
   * @returns 建议使用的旗标名（含 `--` 前缀）；把握不足时为 null（调用方据此**不加**建议句）。
   */
  public static suggest(token: string, known: Iterable<string>): string | null {
    const bare = FlagSuggestion.bareOf(token);
    if (bare.length < FlagSuggestion.MIN_BARE_LENGTH) {
      return null;
    }
    const candidates: { flag: string; bare: string }[] = [];
    for (const flag of known) {
      // 只猜长旗标：短旗标之间仅差一个字母，猜中率不可接受（见类注释的判据段）。
      if (!flag.startsWith('--')) {
        continue;
      }
      const c = FlagSuggestion.bareOf(flag);
      // **首字符必须一致**：手滑极少改掉首字母，而首字母不同几乎总是"另一个词"。
      // 这条把 `--work ⇒ --fork` 这类距离为 1 但毫不相干的猜测整类挡掉（实测过：只有距离
      // 阈值时 `--work` 会被建议成 `--fork`——正是"猜错比不猜更糟"的典型）。
      if (c.length > 0 && c[0] === bare[0]) {
        candidates.push({ flag, bare: c });
      }
    }
    const exact = FlagSuggestion.uniqueExact(bare, candidates);
    if (exact !== null) {
      return exact;
    }
    const uniquePrefix = FlagSuggestion.uniquePrefixOf(bare, candidates);
    if (uniquePrefix !== null) {
      return uniquePrefix;
    }
    return FlagSuggestion.nearest(bare, candidates);
  }

  /**
   * 剥掉全部前导 `-`（`--modle` 与 `-modle` 归一化成同一个名字）。
   * @param flag 原始旗标或 token。
   * @returns 去掉前导横线后的名字（全横线输入返回空串）。
   */
  public static bareOf(flag: string): string {
    return flag.replace(/^-+/, '');
  }

  /**
   * 精确命中（仅剥横线后相等）：`-model` ⇒ `--model`。
   * @param bare 归一化后的名字。
   * @param candidates 候选（已归一化）。
   * @returns 建议旗标；无命中或命中多个不同旗标时为 null。
   */
  private static uniqueExact(
    bare: string,
    candidates: readonly { flag: string; bare: string }[],
  ): string | null {
    const hit = candidates.filter((c) => c.bare === bare);
    const first = hit[0];
    return hit.length === 1 && first !== undefined ? first.flag : null;
  }

  /**
   * 唯一前缀匹配：`--work` ⇒ `--workspace`（存在多个同前缀旗标时返回 null，例如 `--model`）。
   * @param bare 归一化后的名字。
   * @param candidates 候选（已归一化）。
   * @returns 建议旗标；非唯一时为 null。
   */
  private static uniquePrefixOf(
    bare: string,
    candidates: readonly { flag: string; bare: string }[],
  ): string | null {
    const hit = candidates.filter((c) => c.bare.startsWith(bare) && c.bare !== bare);
    const first = hit[0];
    return hit.length === 1 && first !== undefined ? first.flag : null;
  }

  /**
   * 编辑距离最近者（OSA），并按"最长公共前缀"打破**非并列**的次优选择。
   *
   * 并列（距离与公共前缀都相同，例如 `--port` 之外还有 `--sort`）⇒ 返回 null：
   * 猜错的建议会把用户引到另一个错误上，代价高于"没有建议"。
   * @param bare 归一化后的名字。
   * @param candidates 候选（已归一化）。
   * @returns 建议旗标；把握不足时为 null。
   */
  private static nearest(
    bare: string,
    candidates: readonly { flag: string; bare: string }[],
  ): string | null {
    const maxDistance = bare.length <= FlagSuggestion.SHORT_NAME_MAX ? 1 : 2;
    let best: { flag: string; distance: number; prefix: number } | null = null;
    let tied = false;
    for (const c of candidates) {
      // 长度差本身已经超过阈值时无需算距离（OSA ≥ 长度差），省一遍 O(n·m)。
      if (Math.abs(c.bare.length - bare.length) > maxDistance) {
        continue;
      }
      const distance = FlagSuggestion.osaDistance(bare, c.bare);
      if (distance > maxDistance) {
        continue;
      }
      const prefix = FlagSuggestion.commonPrefixLength(bare, c.bare);
      if (best === null) {
        best = { flag: c.flag, distance, prefix };
        tied = false;
        continue;
      }
      if (distance < best.distance || (distance === best.distance && prefix > best.prefix)) {
        best = { flag: c.flag, distance, prefix };
        tied = false;
        continue;
      }
      if (distance === best.distance && prefix === best.prefix) {
        tied = true;
      }
    }
    if (best === null || tied) {
      return null;
    }
    return best.flag;
  }

  /**
   * OSA（Optimal String Alignment）距离：Levenshtein + **相邻换位记 1 个编辑**。
   * @param a 字符串 A。
   * @param b 字符串 B。
   * @returns 编辑距离（非负整数）。
   */
  private static osaDistance(a: string, b: string): number {
    const m = a.length;
    const n = b.length;
    if (m === 0) return n;
    if (n === 0) return m;
    let rowBeforePrev: number[] = [];
    let prev: number[] = [];
    for (let j = 0; j <= n; j += 1) prev[j] = j;
    for (let i = 1; i <= m; i += 1) {
      const cur: number[] = [i];
      for (let j = 1; j <= n; j += 1) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        let value = Math.min((prev[j] ?? 0) + 1, (cur[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
          value = Math.min(value, (rowBeforePrev[j - 2] ?? 0) + 1);
        }
        cur[j] = value;
      }
      rowBeforePrev = prev;
      prev = cur;
    }
    return prev[n] ?? 0;
  }

  /**
   * 两个名字的公共前缀长度（用于在两个"同样近"的候选里选更像的那个）。
   * @param a 字符串 A。
   * @param b 字符串 B。
   * @returns 公共前缀字符数。
   */
  private static commonPrefixLength(a: string, b: string): number {
    const max = Math.min(a.length, b.length);
    let i = 0;
    while (i < max && a[i] === b[i]) i += 1;
    return i;
  }
}
