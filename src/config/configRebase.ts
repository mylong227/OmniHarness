/**
 * 配置重基（组合根资产）：把一份**已解析**配置里的「声明式字段」原样搬到新的工作区根上。
 *
 * 存在的理由（2026-09-19 能力盘点，与被修的数处「声明未接线」同源）：
 * 服务端「切换项目」时 `appServerBase.switchWorkspace` 手工写了 9 个键去调 `ConfigFactory.build`，
 * 其余几十个字段（`fragments` / `selfVerify` / `lspServer` / `costBudgetUsd` / `deferredTools` …）
 * **全部被静默丢弃** —— 最直接的后果是：**切换工作区后系统提示整段消失**，
 * 模型从此在没有行为准则的情况下继续跑（`fragments` 恰恰是 CLI 唯一注入提示的通道）。
 *
 * 本类把「以旧配置为基线重基」变回默认行为，并显式声明**必须丢弃**的字段及其判据：
 * 凡「装配期就把某个工作区路径烘进对象内部」的端口（工具端口持有 `workspaceRoot`、
 * 外溢端口持有 `<workspace>/.omniharness/spill`、长期记忆端口持有 memory.jsonl 路径），
 * 一律不得跨工作区复用，必须由装配层按新根重造。
 *
 * 判据可复核：`grep -n 'workspaceRoot' src/config/corePortsAssembler.ts` —— 凡以 `partial.X` 为
 * 输入、把根路径烘进返回对象的字段，都应进 {@link ConfigRebase.WORKSPACE_COUPLED}。
 */
import type { OmniHarnessConfig, ResolvedConfig } from './configFactory.js';

/** 配置重基器。 */
export class ConfigRebase {
  /**
   * 因「捕获了具体工作区」而必须丢弃、交由装配层按新根重造的字段。
   *
   * - `tools`：`defaultTools(seed.workspaceRoot, …)` 把根烘进 read/write/edit/list/patch/grep/glob 等工具；
   * - `spill`：默认文件外溢后端落在 `<workspace>/.omniharness/spill`；
   * - `longTermMemory`：默认长期记忆落在 `<workspace>/.omniharness/longterm/memory.jsonl`。
   */
  public static readonly WORKSPACE_COUPLED: readonly string[] = [
    'tools',
    'spill',
    'longTermMemory',
  ];

  /**
   * 以既有配置为基线，重基到新的工作区根。
   *
   * @param config 当前已解析配置（其声明式字段将被继承）。
   * @param workspaceRoot 新的工作区根目录。
   * @returns 可直接交给 `ConfigFactory.build` 的未解析配置（工作区耦合端口已剔除）。
   */
  public static forWorkspace(config: ResolvedConfig, workspaceRoot: string): OmniHarnessConfig {
    const base: Record<string, unknown> = { ...config };
    for (const key of ConfigRebase.WORKSPACE_COUPLED) {
      delete base[key];
    }
    return { ...(base as unknown as OmniHarnessConfig), workspaceRoot };
  }
}
