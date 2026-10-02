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

import type { EnforcementMode } from '../ports/security/enforcementMode.js';

export type { EnforcementMode } from '../ports/security/enforcementMode.js';

/**
 * 生效模式解析器（纯函数、无状态、无第三方依赖）。
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

  /**
   * 注入命中在给定生效模式下的**处置**（仅影响「弱证据」是否隔离）。
   *
   * - 非 `enforce`（含 `off` / `shadow`）：恒返回 `'shadow'`——原样放行、只记录（D1：观测档契约）。
   * - `enforce` + **强规则命中**：恒返回 `'block'`（高置信，与来源阈值无关，无降级空间）。
   * - `enforce` + **弱证据命中**：由 `weakPolicy` 决定——`'block'` 隔离、`'observe'` 仅记录不隔离。
   *
   * 为什么弱证据可降级为 observe：弱规则按来源阈值累计（日志/文档易误触），强规则才是明确的指令覆盖/
   * 角色伪造/数据外泄；升档到 `enforce` 时用户可按误报情况选择「只拦强规则」还是「强弱都拦」。
   * 缺省 `weakPolicy` 视为 `'block'`，**保持既有 `enforce` 语义不变**（全拦），避免静默削弱护栏；
   * 选择 `'observe'` 以牺牲部分弱证据拦截来换取更低误伤。
   *
   * @param mode 生效模式。
   * @param isStrongHit 命中是否来自强规则（`hits` 中存在 `severity: 'strong'`）。
   * @param weakPolicy 弱证据策略（`'block'` 隔离 / `'observe'` 仅记录）；缺省按 `'block'`。
   * @returns 处置：`'block'`（隔离） / `'observe'`（仅记录不隔离） / `'shadow'`（原样放行）。
   */
  public static resolveInjectionDisposition(
    mode: EnforcementMode,
    isStrongHit: boolean,
    weakPolicy: 'block' | 'observe' | undefined,
  ): 'block' | 'observe' | 'shadow' {
    if (!EnforcementModeResolver.applies(mode)) {
      return 'shadow';
    }
    if (isStrongHit) {
      return 'block';
    }
    return weakPolicy === 'observe' ? 'observe' : 'block';
  }

  /**
   * 从 CLI 参数归一化护栏生效模式（生产入口默认 `shadow` 观测档常开）。
   *
   * 为什么默认 `shadow` 而非 `off`：护栏的「观测档」只跑检测、记录「本该拦截」的证据，但
   * **原样放行**（见 `guardShadowMode` 端到端测试），零误拦、零行为回归；默认 `off` 会丢掉对生产
   * 流量的覆盖（此前 `promptInjectionGuard` 纯靠显式 opt-in，覆盖面几乎为零）。`--guard-prompt-injection-mode off`
   * 可显式关回；`--guard-prompt-injection`（历史布尔旗标）仍等价 `enforce`。
   *
   * @param guardPromptInjectionMode 显式 `--guard-prompt-injection-mode` 取值（off/shadow/enforce）。
   * @param guardPromptInjection 历史布尔旗标 `--guard-prompt-injection`（`true` ⇒ `enforce`）。
   * @returns 归一化后的生效模式；两者皆未给 ⇒ `'shadow'`（观测档常开）。
   */
  public static fromCliArgs(
    guardPromptInjectionMode: EnforcementMode | undefined,
    guardPromptInjection: boolean | undefined,
  ): EnforcementMode {
    if (guardPromptInjectionMode !== undefined) {
      return EnforcementModeResolver.modeOf(guardPromptInjectionMode);
    }
    if (guardPromptInjection === true) {
      return 'enforce';
    }
    return 'shadow';
  }
}
