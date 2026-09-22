/**
 * 生效模式（EnforcementMode）——把「跑不跑」与「改不改行为」拆成两件事。
 *
 * ## 借鉴来源（`docs/TASK_BOARD.md` §17.2 D1）
 *
 * dsh-jev 把「答案从哪来」（`provider`: mock/live）与「答案是否允许生效」（`mode`: off/shadow/enforce）
 * 做成两个**正交开关**。本仓库既有的安全开关多为二值 opt-in（`promptInjectionGuard` 等），于是
 * 「默认关」丢覆盖面、「默认开」担误报责任，二选一都不舒服——**`shadow` 档**正是这个死结的出口：
 * **跑、记、但不改行为**。
 *
 * 三档语义：
 *  - `off`：不跑（零开销、零行为变更）；
 *  - `shadow`：跑并记录「本该拦截」的证据，但**原样放行**——用于在生产流量上攒真实误报/漏报，
 *    弥补「只靠离线小样本快照度量」的不足（本仓库 `evals/fixtures/injection-snapshot.json` 仅 32 例）；
 *  - `enforce`：跑且生效（真正的护栏）。
 *
 * ## D2 对位：配置层拒绝配出含糊语义
 *
 * {@link EnforcementModeResolver.modeOf} 对**未知字符串抛错**而非静默回落。这与
 * `src/cli/cliEnums.ts` 的既有纪律同源——那里明写「安全相关枚举必须显式校验（fail-closed）」，
 * 因为「参数写错」若静默退化成「全放行」，就把配置错误变成了安全失效。
 */

/** 生效模式：`off` 不跑；`shadow` 跑但不改行为（只记）；`enforce` 跑且生效。 */
export type EnforcementMode = 'off' | 'shadow' | 'enforce';

/**
 * 生效模式解析器（纯函数、无状态、零依赖）。
 */
export class EnforcementModeResolver {
  /** 全部合法取值（供 CLI 白名单 / 文档与实现同源）。 */
  public static readonly MODES: readonly EnforcementMode[] = ['off', 'shadow', 'enforce'];

  /**
   * 归一化取值。
   *
   * 兼容历史二值写法：`true ⇒ enforce`、`false / undefined ⇒ off`（既有配置零行为变更）。
   *
   * @param value 配置值（历史布尔 / 模式字符串 / 未设）。
   * @returns 归一化后的模式。
   * @throws 当传入**未知字符串**时抛错——配置层拒绝，而不是静默回落成 `off`（D2）。
   */
  public static modeOf(value: boolean | string | undefined): EnforcementMode {
    if (value === true) return 'enforce';
    if (value === false || value === undefined) return 'off';
    if (value === 'off' || value === 'shadow' || value === 'enforce') return value;
    throw new Error(
      `未知的生效模式: '${value}'（合法值：${EnforcementModeResolver.MODES.join(' | ')}）`,
    );
  }

  /**
   * 该模式下是否**运行**检测（`shadow` 与 `enforce` 都跑）。
   *
   * @param mode 生效模式。
   * @returns 需要运行检测时为 true。
   */
  public static observes(mode: EnforcementMode): boolean {
    return mode !== 'off';
  }

  /**
   * 该模式下检测结果是否**生效**（仅 `enforce` 改行为）。
   *
   * @param mode 生效模式。
   * @returns 结果允许改变行为时为 true。
   */
  public static applies(mode: EnforcementMode): boolean {
    return mode === 'enforce';
  }
}
