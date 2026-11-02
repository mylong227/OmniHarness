/**
 * 工具工作区根解析：**fs/shell 工具族的单一事实源**。
 *
 * ## 为什么要它（2026-10-06 第六十一轮真实模型跑测实测的连锁故障）
 *
 * 子智能体跑在**隔离工作树**里，而运行时的 `ToolContext.workspaceRoot` **就是**那棵工作树
 * （`SubagentRuntimeFactory` 注入）。但 fs 工具族曾各用各的根：`read_file` / `glob` / `grep` /
 * `shell` 用**运行时 ctx**，而 `write_file` / `edit` / `list_dir` / `apply_patch`（及
 * `view_image` / `browser_screenshot` / `sketch_write`）用**装配期根**（主工作区）。
 *
 * 真机后果（一次真实编排任务的事件流，逐条可查）：
 *
 * 1. 子智能体 `write_file src/parse.mjs` 报「已写入」——**实际写进了主工作区**（隔离失效）；
 * 2. 它随后用 `shell` 跑自测（cwd = 隔离工作树）——**看不到自己刚写的文件**，反复失败；
 * 3. 子代理耗尽步数预算收尾（`⚠️ 未完成：达步数上限`），编排产出「跑了但没落地」；
 * 4. 改动采集在隔离树里只看到**子会话自己的存储文件**（`.omni-storage/*.jsonl`），
 *    于是回执把 patch 说成业务改动，并**谎报**「主工作区尚未改动」——主工作区其实已被改。
 *
 * 规则只有一条：**运行时 ctx 优先**（它为空串时回落到装配期根）。这样「同一相对路径在不同
 * 工具下指向同一棵树」重新成为不变量，隔离工作树对**所有**工具生效。
 */
export class ToolWorkspaceRoot {
  /**
   * 解析本次调用应使用的工作区根。
   *
   * @param configured 装配期注入的根（组合根 `seed.workspaceRoot`）。
   * @param context 工具上下文（子智能体场景下其 `workspaceRoot` 是隔离工作树）。
   * @returns 运行时根（非空时）或装配期根。
   */
  public static of(
    configured: string,
    context: { readonly workspaceRoot?: string | undefined },
  ): string {
    const fromContext = context.workspaceRoot;
    return fromContext === undefined || fromContext === '' ? configured : fromContext;
  }
}
