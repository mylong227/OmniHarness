/**
 * `execLocal.ts` —— **本地/低依赖子命令的分发层**（2026-10-15，销看板 §8.15 的"继承链仍整条加载"）。
 *
 * ## 为什么能省时间（一句话）
 *
 * ESM 只加载**被 import 的模块**，而继承只向上依赖：`CliDataCmds` 及其**祖先**
 * （`CliMcpCmds ← CliServerCmds ← CliIdentityDaemonCmds ← CliBuildConfig ← CliCredentialBuild`）
 * 并不 import 它们的**后代**（`CliCompareCmds` / `CliNativeCmds` / `CliAgentCmds` / `ExecCli`）。
 * 于是把这些命令的分发放到只依赖**链基半段**的本类里，`kv list` 这类命令就不再为链顶的
 * `Agent` / `Runtime` / 编排栈付解析与加载成本。
 *
 * 本机实测（含 ~75ms Node 启动，三次取中位）：`import('./dist/src/cli/cliDataCmds.js')` ≈ 710ms，
 * `import('./dist/src/cli/execCli.js')` ≈ 990ms ⇒ 链顶约占 **280ms**，这条判据把它从本地路径上摘掉。
 *
 * ## 与 `ExecCli` 的分工（单一实现，不复制分发）
 *
 * 本类**持有**这些命令的判定；`ExecCli` 继承本类并**先委托**（`runLocal` 返回 `undefined` 即"不归我管"），
 * 再处理链顶命令（`compare` / `native` / `goal` / `workflow` / `lsp` / `routines` / `tui` /
 * `evolution` / `capability` / `license`）与默认的 agent 路径。判据
 * （`cliStartupBudget.test.ts`）会钉住"`exec.ts` 必须先试本地分发、且不得静态 import `execCli`"，
 * 以防后人为了省事把整条链又拉回冷启动路径。
 *
 * ## 诚实边界
 *
 * 这**不是**"组合替代继承"的全部：链基那 6 个类仍是单继承（本次只是让**链顶**不再被本地命令加载）。
 * 进一步的收益要按层拆（每层一个可独立加载的分发），属独立一片，已在看板 §8.22 登记。
 */
import { CliDataCmds } from './cliDataCmds.ts';

/** 本地/低依赖子命令的分发层（链基半段）。 */
export class ExecLocal extends CliDataCmds {
  /**
   * 分发**不依赖链顶**的子命令。
   *
   * 返回 `undefined` 表示"本层不认识这个命令"（调用方据此去加载链顶），**不是**错误——
   * 未知命令最终会落到 agent 路径（本仓 `omniharness "任务描述"` 的既有设计）。
   * @param argv 原始命令行参数（不含 node 与脚本入口）。
   * @returns 退出码；不归本层管时为 undefined。
   */
  public async runLocal(argv: readonly string[]): Promise<number | undefined> {
    const [command] = argv;
    if (command === 'server') return this.runServer(argv.slice(1));
    if (command === 'serve') return this.runServe(argv.slice(1));
    if (command === 'schema') return this.runSchema(argv.slice(1));
    if (command === 'session') return this.runSession(argv.slice(1));
    if (command === 'plugin') return this.runPlugin(argv.slice(1));
    if (command === 'profile') return this.runProfile(argv.slice(1));
    if (command === 'bundle') return this.runBundle(argv.slice(1));
    if (command === 'doctor') return this.runDoctor(argv.slice(1));
    if (command === 'mcp') return this.runMcp(argv.slice(1));
    if (command === 'kv') return this.runKv(argv.slice(1));
    if (command === 'vault') return this.runVault(argv.slice(1));
    if (command === 'identity') return this.runIdentity(argv.slice(1));
    if (command === 'daemon') return this.runDaemon(argv.slice(1));
    if (command === 'audit') return this.runAudit(argv.slice(1));
    if (command === 'trace') return this.runTrace(argv.slice(1));
    if (command === 'sdk') return this.runSdk(argv.slice(1));
    if (command === 'boost') return this.runBoost(argv.slice(1));
    if (command === 'auth') return this.runAuth(argv.slice(1));
    return undefined;
  }
}
