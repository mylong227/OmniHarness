/**
 * 子进程环境构造：清理外部工具注入的 `NODE_OPTIONS` shim。
 *
 * 为什么需要：WorkBuddy / CodeBuddy 一类宿主会通过 `NODE_OPTIONS` 注入
 * `node-language-shim.cjs` / safe-delete / brokered-fs 钩子。子进程继承后，tsc、测试运行器等
 * 会被代理的 fs hook 污染（实测表现为异常 OOM 或行为不一致）。ShellTool 与交互式 Shell 必须
 * 使用同一份清理口径，否则两条执行路径的行为会漂移。
 */
export class ShellChildEnv {
  /** 需要从 `NODE_OPTIONS` 中剔除的代理 shim 模块（命中即丢）。 */
  private static readonly PROXY_SHIM = /node-language-shim\.cjs|node-safe-delete|node-brokered-fs/i;

  /**
   * 构造清理后的环境变量副本。
   * @returns 清理后的 `process.env` 副本（不修改进程环境）
   */
  public static clean(): NodeJS.ProcessEnv {
    const rawNodeOptions = process.env['NODE_OPTIONS'] ?? '';
    const parts = rawNodeOptions.split(/\s+/).filter((opt) => opt !== '');
    const kept: string[] = [];
    for (let index = 0; index < parts.length; index += 1) {
      const opt = parts[index]!;
      if (ShellChildEnv.PROXY_SHIM.test(opt)) {
        // 形如 `--require <shim>`：模块被丢后 `--require` 会变成悬空旗标（Node 直接报错），
        // 故连同紧邻的 require 旗标一起丢。`--require=<shim>` 由上面的 test 整段命中。
        if (kept.at(-1) === '--require' || kept.at(-1) === '-r') kept.pop();
        continue;
      }
      const next = parts[index + 1];
      if (
        (opt === '--require' || opt === '-r') &&
        next !== undefined &&
        ShellChildEnv.PROXY_SHIM.test(next)
      ) {
        index += 1;
        continue;
      }
      kept.push(opt);
    }
    return { ...process.env, NODE_OPTIONS: kept.join(' ') };
  }
}
