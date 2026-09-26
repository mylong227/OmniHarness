/**
 * 旗标守卫：命令行里的**未知 `--flag` 一律 fail-closed**，不再静默忽略。
 *
 * ## 动因（2026-09-26 实测事故，代价是一次真实 pilot 花费）
 *
 * `benchmark/swebench_predict.mjs` 用 `arg(name)` 取值，而它**对拼错的旗标只是返回 undefined**：
 * 写成驼峰（`best-of-N` 用大写 N）时脚本不报错，于是「产品口径 = 4 候选」被静默跑成**单候选**，
 * 只有回头读日志首行才发现。同族风险更贵的一处是判分脚本的信任闸 `--gold-control` / `--gold-report`：
 * 拼错即**闸静默失效**，报告仍照常出分——正是「不可信分数被当成绩效」的入口。
 * 本仓已有一条同族纪律（接线门禁：CLI 旗标不得只解析不使用）；**这里是它的镜像问题**：
 * 不存在的旗标不得被静默接受。
 *
 * ## 为什么逻辑在 TS 而不只在 .mjs 里
 *
 * 纯函数放在这里⇒ 进得了 `tests/unit`（CI 覆盖），而 .mjs 侧只留一层搬运。
 * 先前只写在 `benchmark/lib/flagGuard.mjs` 时，证据只有「手工跑两条命令」，无法进 CI 门禁。
 */
export class FlagGuard {
  /**
   * 匹配「**被真正解析**」的旗标字面量。只认本仓 benchmark 脚本实际使用的三种写法
   * （已逐一核对）：`arg('--x')`、`process.argv.includes('--x')`、`process.argv.indexOf('--x')`。
   *
   * ⚠️ 新增另一种解析写法时必须同步本正则，否则该旗标会被误判为未知而**大声报错**——
   * 方向安全（错在拒绝，不会静默放行）。另：注释里不要写**错的**旗标字面量，白名单来自源码文本。
   */
  private static readonly parsePattern = /(?:arg|includes|indexOf)\(\s*'(--[a-z0-9][a-z0-9-]*)'/g;

  /**
   * 从脚本源码文本收集「被解析」的旗标集合。
   * @param source 脚本源码全文。
   * @returns 旗标集合；若一个都没扫到则抛错（说明解析写法已变，此时绝不能静默放行一切）。
   */
  public static knownFlagsOf(source: string): ReadonlySet<string> {
    const found = new Set([...source.matchAll(FlagGuard.parsePattern)].map((m) => m[1] ?? ''));
    found.delete('');
    if (found.size === 0) {
      throw new Error(
        'FlagGuard 未能从源码扫到任何被解析的旗标——解析写法可能已变（见 FlagGuard.parsePattern）。',
      );
    }
    return found;
  }

  /**
   * 列出命令参数里**不在白名单**中的旗标。
   * @param argv 命令参数（不含 node 与脚本路径）。
   * @param known 白名单。
   * @returns 未知旗标名（去重、保持出现顺序）；`--x=1` 取 `--x`。
   */
  public static unknownFlags(argv: readonly string[], known: ReadonlySet<string>): string[] {
    const out: string[] = [];
    for (const token of argv) {
      if (!token.startsWith('--')) continue;
      const name = token.split('=')[0] ?? token;
      if (!known.has(name) && !out.includes(name)) out.push(name);
    }
    return out;
  }

  /**
   * 生成可读的报错文本（含「大小写敏感」的就近提示——本次事故正是大小写写错）。
   * @param unknown 未知旗标。
   * @param known 白名单（用于就近提示与「已支持」清单）。
   * @returns 多行报错文本。
   */
  public static unknownFlagMessage(unknown: readonly string[], known: ReadonlySet<string>): string {
    const hintOf = (name: string): string => {
      const lower = name.toLowerCase();
      const near = [...known].filter((k) => k.toLowerCase() === lower);
      return near.length > 0 ? `（是否想写 ${near.join(' / ')}？大小写敏感）` : '';
    };
    return (
      `❌ 未知旗标：${unknown.map((u) => `${u}${hintOf(u)}`).join('、')}\n` +
      '   对未知旗标**不再静默忽略**——它曾把「产品口径 4 候选」静默跑成「单候选」，\n' +
      '   也曾让判分侧的信任闸（--gold-control / --gold-report）静默失效。\n' +
      `   已支持：${[...known].sort().join(' ')}`
    );
  }
}
