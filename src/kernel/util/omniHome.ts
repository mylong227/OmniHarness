/**
 * OmniHarness **用户级归属根**的单一事实源（2026-10-26，C 盘磁盘爆炸问题的归属收口）。
 *
 * ## 为什么需要它（实测事故）
 *
 * 本仓所有用户级状态（会话存档、serve-*.pid、插件、profiles、automations、routines、
 * trust.json、vault.key、mcp-tokens）各自写一份 `join(homedir(), '.omniharness', …)`，
 * 共 15+ 处——「换盘」这个诉求一出现，15 处就都得改一遍，且漏一处就是"一半数据在新盘、
 * 一半在旧盘"的静默分裂（与 `SessionStorageLocation` 注释里记录的四处分裂是同一类事故）。
 * 归属路径从此只有本文件一处定义，其余全部转引。
 *
 * ## 口径（本文件即裁决）
 *
 * - **显式注入 > `OMNI_HOME` 环境变量 > `~/.omniharness`**。显式参数压过环境变量是刻意的：
 *   全仓既有判据靠"注入临时目录当 home"保持封闭（`userHomedir` / 构造参数），一旦真实机器
 *   `setx OMNI_HOME D:\…`，封闭性就会被打穿——注入了显式值的调用方不受环境漂移影响；
 *   生产路径全部不传显式值，由环境变量统一接管。
 * - **`OMNI_HOME` 是「整体搬盘」的唯一旋钮**：`setx OMNI_HOME D:\omniharness-home` 一次，
 *   所有组件（serve / CLI / 桌面）的会话、pid、插件、profiles、automations、临时目录全部跟随；
 * - 会话目录仍支持 `OMNI_SESSIONS_DIR` 单独覆盖（既有语义，见 `SessionStorageLocation`）；
 * - 项目临时根 `tmpRoot()`：`OMNI_TMP_DIR` > `<home>/tmp`——Chrome user-data、worktree 副本、
 *   CDP stub 截图这类"用完即弃"的东西集中到自家屋顶下（而不是散在全体应用共享的 OS Temp 里），
 *   清扫器只扫自家目录就不会误伤别人，跨盘搬迁也一并带走。
 *
 * ## 为什么不是配置文件里的一个键
 *
 * 用户级配置文件**就在** `~/.omniharness/omniharness.json` 里——"配置文件声明配置目录在哪"
 * 是自举环（文件搬走后读它的人找不到它）。环境变量没有这个问题，且与既有
 * `OMNI_SESSIONS_DIR` / `OMNI_SERVE_TOKEN` 等旋钮同一形态。
 */
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** OmniHarness 用户级归属根解析（无状态）。 */
export class OmniHome {
  /** 覆盖归属根的环境变量名。 */
  public static readonly ENV_HOME = 'OMNI_HOME';

  /** 覆盖项目临时根的环境变量名。 */
  public static readonly ENV_TMP = 'OMNI_TMP_DIR';

  /**
   * 归属根：显式注入优先，其次 `OMNI_HOME`（解析为绝对路径），否则 `~/.omniharness`。
   * @param explicitHome 显式家目录（既有判据的注入点；给了就**不走**环境变量）。
   * @param env 环境变量源（测试注入；缺省 `process.env`）。
   * @returns 绝对路径。
   */
  public static dir(
    explicitHome: string | undefined = undefined,
    env: NodeJS.ProcessEnv = process.env,
  ): string {
    if (explicitHome !== undefined && explicitHome.trim() !== '') {
      return join(explicitHome, '.omniharness');
    }
    const configured = env[OmniHome.ENV_HOME];
    if (configured !== undefined && configured.trim() !== '') return resolve(configured.trim());
    return join(homedir(), '.omniharness');
  }

  /**
   * 用户级会话存档目录（`SessionStorageLocation.defaultDir` 的底座）。
   * @param explicitHome 显式家目录（测试注入）。
   * @param env 环境变量源（测试注入）。
   * @returns 绝对路径。
   */
  public static sessionsDir(
    explicitHome: string | undefined = undefined,
    env: NodeJS.ProcessEnv = process.env,
  ): string {
    return join(OmniHome.dir(explicitHome, env), 'sessions');
  }

  /**
   * 项目临时根：`OMNI_TMP_DIR` 优先，否则 `<home>/tmp`。
   *
   * 为什么不再直接用 `os.tmpdir()`：那是全体应用共享的目录，本仓的 Chrome profile / worktree
   * 副本泄留在里面既难归属也难清扫（2026-10-26 实测 19 GB 的 Temp 里 10 GB 是本仓前缀）。
   * 集中到自家屋顶后，清扫器按目录整体扫即可；已泄留在 OS Temp 里的历史孤儿由
   * `gc` 命令与启动清扫**额外扫一遍 OS Temp**（按前缀识别本仓产物）兜底。
   * @param explicitHome 显式家目录（测试注入）。
   * @param env 环境变量源（测试注入）。
   * @returns 绝对路径。
   */
  public static tmpRoot(
    explicitHome: string | undefined = undefined,
    env: NodeJS.ProcessEnv = process.env,
  ): string {
    const configured = env[OmniHome.ENV_TMP];
    if (configured !== undefined && configured.trim() !== '') return resolve(configured.trim());
    return join(OmniHome.dir(explicitHome, env), 'tmp');
  }
}
